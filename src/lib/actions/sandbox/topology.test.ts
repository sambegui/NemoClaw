// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildTopologyCheck,
  buildTopologyHops,
  classifyTopologyOutcome,
  proxyInterceptionFor,
  runTopologyChecks,
  type TopologyHop,
  type TopologyProbeDeps,
} from "./topology";

const gatewayHop: TopologyHop = {
  id: "cli->openshell-gateway",
  label: "CLI host → OpenShell gateway",
  host: "gw.internal",
  port: 8080,
  kind: "tcp",
  description: "OpenShell gateway route",
};

describe("classifyTopologyOutcome (#4874)", () => {
  it("returns ok for a reachable hop", () => {
    expect(classifyTopologyOutcome({ ok: true, dnsResolved: true })).toBe("ok");
  });

  it("classifies a DNS failure", () => {
    expect(classifyTopologyOutcome({ ok: false, dnsResolved: false })).toBe("dns");
    expect(classifyTopologyOutcome({ ok: false, errorCode: "ENOTFOUND" })).toBe("dns");
  });

  it("classifies a TLS/CA failure", () => {
    expect(classifyTopologyOutcome({ ok: false, tlsError: true })).toBe("tls");
    expect(classifyTopologyOutcome({ ok: false, errorCode: "CERT_HAS_EXPIRED" })).toBe("tls");
  });

  it("classifies a port conflict", () => {
    expect(classifyTopologyOutcome({ ok: false, errorCode: "EADDRINUSE" })).toBe("port-conflict");
    expect(classifyTopologyOutcome({ ok: false, portConflict: true })).toBe("port-conflict");
  });

  it("classifies a proxy denial when a proxy intercepts the host", () => {
    expect(
      classifyTopologyOutcome({
        ok: false,
        dnsResolved: true,
        errorCode: "ECONNREFUSED",
        proxyInterception: { configured: true, bypassed: false },
      }),
    ).toBe("proxy");
  });

  it("classifies a sandbox policy denial", () => {
    expect(classifyTopologyOutcome({ ok: false, policyDenied: true })).toBe("policy");
  });

  it("classifies a timeout", () => {
    expect(classifyTopologyOutcome({ ok: false, errorCode: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyTopologyOutcome({ ok: false, timedOut: true })).toBe("timeout");
  });

  it("falls back to a generic route failure", () => {
    expect(classifyTopologyOutcome({ ok: false, errorCode: "ECONNREFUSED" })).toBe("route");
  });

  it("prefers DNS over proxy when both signals are present", () => {
    expect(
      classifyTopologyOutcome({
        ok: false,
        dnsResolved: false,
        proxyInterception: { configured: true, bypassed: false },
      }),
    ).toBe("dns");
  });

  it("marks a skipped probe", () => {
    expect(classifyTopologyOutcome({ ok: false, skipped: true })).toBe("skipped");
  });
});

describe("buildTopologyCheck", () => {
  it("reports a misconfigured route as a fail naming the broken hop and reason", () => {
    const check = buildTopologyCheck(gatewayHop, {
      ok: false,
      dnsResolved: true,
      errorCode: "ECONNREFUSED",
      errorMessage: "connect ECONNREFUSED",
    });
    expect(check.group).toBe("Topology");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("CLI host → OpenShell gateway");
    expect(check.detail).toContain("gw.internal:8080");
    expect(check.detail).toContain("route failure");
    expect(check.hint).toContain("no route");
  });

  it("downgrades an optional hop failure to a warning", () => {
    const dashboardHop: TopologyHop = { ...gatewayHop, optional: true };
    const check = buildTopologyCheck(dashboardHop, { ok: false, errorCode: "ECONNREFUSED" });
    expect(check.status).toBe("warn");
  });

  it("gives a DNS-specific remediation hint", () => {
    const check = buildTopologyCheck(gatewayHop, { ok: false, dnsResolved: false });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("dns failure");
    expect(check.hint).toContain("does not resolve");
  });

  it("reports ok with a reachable detail", () => {
    const check = buildTopologyCheck(gatewayHop, { ok: true, dnsResolved: true });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("reachable");
    expect(check.hint).toBeUndefined();
  });
});

describe("proxyInterceptionFor", () => {
  it("treats loopback hosts as bypassed even with a proxy set", () => {
    const result = proxyInterceptionFor("localhost", "http", { HTTP_PROXY: "http://proxy:3128" });
    expect(result).toEqual({ configured: true, bypassed: true });
  });

  it("intercepts a remote host when a proxy is configured and not bypassed", () => {
    const result = proxyInterceptionFor("gw.internal", "http", { HTTP_PROXY: "http://proxy:3128" });
    expect(result).toEqual({ configured: true, bypassed: false });
  });

  it("honors NO_PROXY suffix matches", () => {
    const result = proxyInterceptionFor("gw.internal", "http", {
      HTTP_PROXY: "http://proxy:3128",
      NO_PROXY: ".internal",
    });
    expect(result.bypassed).toBe(true);
  });
});

describe("buildTopologyHops", () => {
  it("builds the gateway and dashboard hops with host overrides", () => {
    const hops = buildTopologyHops({
      gatewayHost: "gw.example",
      gatewayPort: 9090,
      dashboardHost: "ui.example",
      dashboardPort: 18789,
    });
    const ids = hops.map((hop) => hop.id);
    expect(ids).toContain("cli->openshell-gateway");
    expect(ids).toContain("cli->openclaw-dashboard");
    const gateway = hops.find((hop) => hop.id === "cli->openshell-gateway");
    expect(gateway?.host).toBe("gw.example");
    expect(gateway?.port).toBe(9090);
  });

  it("adds an inference hop derived from an explicit endpoint", () => {
    const hops = buildTopologyHops({
      inferenceEndpoint: "https://api.example.com:8443/v1/models",
    });
    const inference = hops.find((hop) => hop.id === "gateway->inference");
    expect(inference).toBeDefined();
    expect(inference?.host).toBe("api.example.com");
    expect(inference?.port).toBe(8443);
    expect(inference?.kind).toBe("https");
  });

  it("omits the inference hop when the provider has no known endpoint", () => {
    const hops = buildTopologyHops({ inferenceProvider: "ollama-local" });
    expect(hops.find((hop) => hop.id === "gateway->inference")).toBeUndefined();
  });
});

describe("runTopologyChecks (integration with injected probes)", () => {
  function deps(overrides: Partial<TopologyProbeDeps> = {}): TopologyProbeDeps {
    return {
      resolveDns: async () => true,
      tcpConnect: async () => ({ ok: true }),
      tlsConnect: async () => ({ ok: true }),
      proxyEnv: {},
      ...overrides,
    };
  }

  it("reports the broken hop and its reason for a misconfigured gateway route", async () => {
    const checks = await runTopologyChecks(
      { gatewayHost: "gw.internal", gatewayPort: 8080, dashboardHost: "localhost" },
      deps({
        tcpConnect: async (host) =>
          host === "gw.internal"
            ? { ok: false, errorCode: "ECONNREFUSED", errorMessage: "connect ECONNREFUSED" }
            : { ok: true },
      }),
    );
    const gateway = checks.find((check) => check.label === "OpenShell gateway route");
    expect(gateway?.status).toBe("fail");
    expect(gateway?.detail).toContain("route failure");
    expect(gateway?.detail).toContain("gw.internal:8080");
  });

  it("reports a DNS failure when the gateway host does not resolve", async () => {
    const checks = await runTopologyChecks(
      { gatewayHost: "missing.host" },
      deps({ resolveDns: async (host) => host !== "missing.host" }),
    );
    const gateway = checks.find((check) => check.label === "OpenShell gateway route");
    expect(gateway?.status).toBe("fail");
    expect(gateway?.detail).toContain("dns failure");
    expect(gateway?.hint).toContain("does not resolve");
  });

  it("reports all hops healthy when every probe succeeds", async () => {
    const checks = await runTopologyChecks(
      { inferenceEndpoint: "https://api.example.com/v1/models" },
      deps(),
    );
    expect(checks.every((check) => check.status === "ok")).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(3);
  });
});
