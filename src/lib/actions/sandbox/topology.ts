// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-host topology connectivity checks (#4874).
 *
 * In multi-host or multi-namespace deployments the NemoClaw CLI host, the
 * OpenShell gateway, the OpenClaw gateway/TUI (dashboard), the sandbox runtime,
 * and the inference endpoint can each live on a different host, port, or network
 * namespace. A broken route between any two of those hops is usually only
 * discovered after onboarding or `connect`/`status` fails, with no signal about
 * *which* hop is broken.
 *
 * This module models the supported topology as a list of directed hops, probes
 * each one, and classifies a failure into a specific reason (DNS, port conflict,
 * proxy denial, TLS/CA, sandbox policy, route, or timeout) so the doctor can
 * point the operator at the broken hop and an actionable remediation.
 *
 * The hop model (`buildTopologyHops`), the failure classifier
 * (`classifyTopologyOutcome`), and the check builder (`buildTopologyCheck`) are
 * pure so they can be unit-tested without touching the network. The real
 * network probing lives behind injectable deps (`TopologyProbeDeps`).
 */

import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { CLI_NAME } from "../../cli/branding";
import { DASHBOARD_PORT, GATEWAY_PORT } from "../../core/ports";
import type { DoctorCheck } from "./doctor";

/** Docs page describing the supported production topology and port/host map. */
export const TOPOLOGY_DOCS_REF = "docs: Multi-Host Topology (deployment/multi-host-topology)";

const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export type TopologyHopKind = "tcp" | "http" | "https";

export type TopologyHop = {
  /** Stable identifier, e.g. `cli->openshell-gateway`. */
  id: string;
  /** Human label, e.g. `CLI host → OpenShell gateway`. */
  label: string;
  host: string;
  port: number;
  kind: TopologyHopKind;
  /** What this hop carries, used in the doctor detail line. */
  description: string;
  /**
   * Optional hops downgrade a failure to `warn` instead of `fail` (the route is
   * not strictly required for the control plane to function).
   */
  optional?: boolean;
};

export type TopologyFailureReason =
  | "ok"
  | "dns"
  | "port-conflict"
  | "proxy"
  | "tls"
  | "policy"
  | "route"
  | "timeout"
  | "skipped";

/**
 * Structured, transport-agnostic result of attempting a single hop. The fields
 * are intentionally low-level signals so the classifier can distinguish failure
 * modes; the real probe and tests both produce this shape.
 */
export type TopologyProbeOutcome = {
  ok: boolean;
  /** Whether the destination host resolved. `false` => DNS failure. */
  dnsResolved?: boolean;
  /** Errno / TLS error code (e.g. ECONNREFUSED, ETIMEDOUT, CERT_HAS_EXPIRED). */
  errorCode?: string;
  errorMessage?: string;
  /** TLS handshake / certificate verification failed. */
  tlsError?: boolean;
  /** The sandbox egress policy denied this route. */
  policyDenied?: boolean;
  /** A proxy sits in front of this host and did not bypass it. */
  proxyInterception?: { configured: boolean; bypassed: boolean };
  /** Another process already owns the expected port. */
  portConflict?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  /** Probe was not run (e.g. inference endpoint unknown). */
  skipped?: boolean;
  skipReason?: string;
};

const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
]);

/**
 * Map a raw probe outcome to a single failure reason. Ordering matters: the
 * most specific, most actionable diagnosis wins (a DNS failure is reported as
 * DNS even when a proxy is also configured for the host).
 */
export function classifyTopologyOutcome(outcome: TopologyProbeOutcome): TopologyFailureReason {
  if (outcome.skipped) return "skipped";
  if (outcome.ok) return "ok";
  if (outcome.policyDenied) return "policy";

  const code = (outcome.errorCode || "").toUpperCase();
  if (outcome.dnsResolved === false || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "dns";
  }
  if (outcome.tlsError || code.startsWith("CERT_") || TLS_ERROR_CODES.has(code)) {
    return "tls";
  }
  if (outcome.portConflict || code === "EADDRINUSE") {
    return "port-conflict";
  }
  const proxy = outcome.proxyInterception;
  if (proxy?.configured && !proxy.bypassed) {
    return "proxy";
  }
  if (outcome.timedOut || code === "ETIMEDOUT") {
    return "timeout";
  }
  return "route";
}

function topologyHint(reason: TopologyFailureReason, hop: TopologyHop): string | undefined {
  const target = `${hop.host}:${hop.port}`;
  switch (reason) {
    case "ok":
    case "skipped":
      return undefined;
    case "dns":
      return `${hop.host} does not resolve — fix DNS or add a host alias for ${hop.host}; ${TOPOLOGY_DOCS_REF}`;
    case "port-conflict":
      return `another process already owns port ${hop.port} on ${hop.host} — free the port or set a distinct port for this hop; ${TOPOLOGY_DOCS_REF}`;
    case "proxy":
      return `an HTTP(S) proxy is intercepting ${target} — add ${hop.host} to NO_PROXY or allow it in the proxy; ${TOPOLOGY_DOCS_REF}`;
    case "tls":
      return `TLS/CA verification failed for ${target} — install the CA bundle or fix the certificate; ${TOPOLOGY_DOCS_REF}`;
    case "policy":
      return `the sandbox egress policy denied ${target} — allow it with \`${CLI_NAME} <name> policy\`; ${TOPOLOGY_DOCS_REF}`;
    case "timeout":
      return `no response from ${target} within the probe window — check firewall/VPN routing and that the service is up; ${TOPOLOGY_DOCS_REF}`;
    default:
      return `no route to ${target} — verify the host, port, and that the service is listening; ${TOPOLOGY_DOCS_REF}`;
  }
}

function topologyDetail(reason: TopologyFailureReason, hop: TopologyHop): string {
  const route = `${hop.label} (${hop.host}:${hop.port})`;
  if (reason === "ok") return `${route} reachable`;
  if (reason === "skipped") return `${route} not probed`;
  return `${route} — ${reason} failure`;
}

/**
 * Build the doctor check for one hop from its probe outcome. A required hop that
 * fails is `fail`; an optional hop that fails is `warn`; a skipped probe is
 * `info`.
 */
export function buildTopologyCheck(
  hop: TopologyHop,
  outcome: TopologyProbeOutcome,
): DoctorCheck {
  const reason = classifyTopologyOutcome(outcome);
  let status: DoctorCheck["status"];
  if (reason === "ok") status = "ok";
  else if (reason === "skipped") status = "info";
  else status = hop.optional ? "warn" : "fail";

  const detailParts = [topologyDetail(reason, hop)];
  if (reason === "skipped" && outcome.skipReason) detailParts.push(outcome.skipReason);
  else if (outcome.errorMessage && reason !== "ok") detailParts.push(outcome.errorMessage);

  return {
    group: "Topology",
    label: hop.description,
    status,
    detail: detailParts.join(": "),
    hint: topologyHint(reason, hop),
  };
}

export type TopologyInput = {
  gatewayHost?: string;
  gatewayPort?: number;
  dashboardHost?: string;
  dashboardPort?: number;
  inferenceProvider?: string;
  /** Explicit inference endpoint; derived from the provider when omitted. */
  inferenceEndpoint?: string | null;
  /**
   * Resolves a provider name to its remote health endpoint. Injected by the
   * caller (the doctor) so this module stays decoupled from the heavier
   * inference health module and its runtime dependencies.
   */
  resolveProviderEndpoint?: (provider: string) => string | null;
  env?: NodeJS.ProcessEnv;
};

function parseEndpoint(
  endpoint: string,
): { host: string; port: number; kind: TopologyHopKind } | null {
  try {
    const url = new URL(endpoint);
    const https = url.protocol === "https:";
    const port = url.port ? Number(url.port) : https ? 443 : 80;
    if (!url.hostname || !Number.isFinite(port)) return null;
    return { host: url.hostname, port, kind: https ? "https" : "http" };
  } catch {
    return null;
  }
}

/**
 * Build the supported multi-host topology hop list for a sandbox. Hosts default
 * to `localhost` for a single-host deployment but can be overridden per hop via
 * `NEMOCLAW_GATEWAY_HOST` / `NEMOCLAW_DASHBOARD_HOST` for split deployments.
 */
export function buildTopologyHops(input: TopologyInput = {}): TopologyHop[] {
  const env = input.env ?? process.env;
  const gatewayHost = input.gatewayHost ?? env.NEMOCLAW_GATEWAY_HOST ?? "localhost";
  const gatewayPort = input.gatewayPort ?? GATEWAY_PORT;
  const dashboardHost = input.dashboardHost ?? env.NEMOCLAW_DASHBOARD_HOST ?? "localhost";
  const dashboardPort = input.dashboardPort ?? DASHBOARD_PORT;

  const hops: TopologyHop[] = [
    {
      id: "cli->openshell-gateway",
      label: "CLI host → OpenShell gateway",
      host: gatewayHost,
      port: gatewayPort,
      kind: "tcp",
      description: "OpenShell gateway route",
    },
    {
      id: "cli->openclaw-dashboard",
      label: "CLI host → OpenClaw gateway/TUI",
      host: dashboardHost,
      port: dashboardPort,
      kind: "http",
      description: "Dashboard reachability",
      optional: true,
    },
  ];

  const endpoint =
    input.inferenceEndpoint ??
    (input.inferenceProvider && input.resolveProviderEndpoint
      ? input.resolveProviderEndpoint(input.inferenceProvider)
      : null);
  if (endpoint) {
    const parsed = parseEndpoint(endpoint);
    if (parsed) {
      hops.push({
        id: "gateway->inference",
        label: "Gateway → inference endpoint",
        host: parsed.host,
        port: parsed.port,
        kind: parsed.kind,
        description: "Inference endpoint route",
      });
    }
  }

  return hops;
}

export type TopologyProbeDeps = {
  resolveDns: (host: string) => Promise<boolean>;
  tcpConnect: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }>;
  tlsConnect: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<{ ok: boolean; errorCode?: string; errorMessage?: string; tlsError?: boolean }>;
  proxyEnv: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Decide whether the configured HTTP(S) proxy would intercept this host. A host
 * listed in NO_PROXY (or any loopback address) is bypassed.
 */
export function proxyInterceptionFor(
  host: string,
  kind: TopologyHopKind,
  env: NodeJS.ProcessEnv,
): { configured: boolean; bypassed: boolean } {
  const proxy =
    kind === "https"
      ? env.https_proxy || env.HTTPS_PROXY
      : env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY;
  const configured = Boolean(proxy);
  if (!configured) return { configured: false, bypassed: true };

  const noProxy = (env.no_proxy || env.NO_PROXY || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const lowerHost = host.toLowerCase();
  const bypassed =
    isLoopback(host) ||
    noProxy.includes("*") ||
    noProxy.some(
      (entry) =>
        lowerHost === entry ||
        lowerHost === entry.replace(/^\./, "") ||
        lowerHost.endsWith(`.${entry.replace(/^\./, "")}`),
    );
  return { configured, bypassed };
}

function defaultResolveDns(host: string): Promise<boolean> {
  if (net.isIP(host) !== 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    dns.lookup(host, (err) => resolve(!err));
  });
}

function defaultTcpConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (result: { ok: boolean; errorCode?: string; errorMessage?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, errorCode: "ETIMEDOUT" }));
    socket.once("connect", () => done({ ok: true }));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done({ ok: false, errorCode: err.code, errorMessage: err.message }),
    );
  });
}

function defaultTlsConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string; tlsError?: boolean }> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host });
    let settled = false;
    const done = (result: {
      ok: boolean;
      errorCode?: string;
      errorMessage?: string;
      tlsError?: boolean;
    }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, errorCode: "ETIMEDOUT" }));
    socket.once("secureConnect", () =>
      done(socket.authorized ? { ok: true } : { ok: false, tlsError: true, errorCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    );
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code || "";
      const tlsError = code.startsWith("CERT_") || TLS_ERROR_CODES.has(code);
      done({ ok: false, errorCode: code, errorMessage: err.message, tlsError });
    });
  });
}

export function defaultTopologyProbeDeps(): TopologyProbeDeps {
  return {
    resolveDns: defaultResolveDns,
    tcpConnect: defaultTcpConnect,
    tlsConnect: defaultTlsConnect,
    proxyEnv: process.env,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  };
}

/** Probe a single hop, producing a structured outcome for classification. */
export async function probeTopologyHop(
  hop: TopologyHop,
  deps: TopologyProbeDeps,
): Promise<TopologyProbeOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const proxyInterception = proxyInterceptionFor(hop.host, hop.kind, deps.proxyEnv);

  const dnsResolved = await deps.resolveDns(hop.host);
  if (!dnsResolved) {
    return { ok: false, dnsResolved: false, proxyInterception };
  }

  const result =
    hop.kind === "https"
      ? await deps.tlsConnect(hop.host, hop.port, timeoutMs)
      : await deps.tcpConnect(hop.host, hop.port, timeoutMs);

  return {
    ok: result.ok,
    dnsResolved: true,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    tlsError: (result as { tlsError?: boolean }).tlsError,
    timedOut: result.errorCode === "ETIMEDOUT",
    proxyInterception,
  };
}

/**
 * Run the full multi-host topology connectivity sweep and return one doctor
 * check per hop. Network access is injectable for tests; the default deps use
 * Node's net/dns/tls.
 */
export async function runTopologyChecks(
  input: TopologyInput = {},
  deps: TopologyProbeDeps = defaultTopologyProbeDeps(),
): Promise<DoctorCheck[]> {
  const hops = buildTopologyHops(input);
  const checks: DoctorCheck[] = [];
  for (const hop of hops) {
    let outcome: TopologyProbeOutcome;
    try {
      outcome = await probeTopologyHop(hop, deps);
    } catch (err) {
      outcome = {
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    checks.push(buildTopologyCheck(hop, outcome));
  }
  return checks;
}
