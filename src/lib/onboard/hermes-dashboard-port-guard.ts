// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Security guard for the NemoClaw browser dashboard port under Hermes.
 *
 * Hermes exposes its OpenAI-compatible API / gateway on a dedicated port
 * (8642 by default — see agents/hermes/manifest.yaml). That port is *not* a
 * chat UI. If an operator points NEMOCLAW_DASHBOARD_PORT (or
 * --control-ui-port) at it, onboarding must hard-fail before any sandbox is
 * created rather than silently building a sandbox whose dashboard forward
 * collides with the API surface (#4984). The check is Hermes-scoped: the
 * reserved API ports are derived from the agent manifest, so non-Hermes
 * agents (OpenClaw) are unaffected.
 */

/** Minimal agent shape needed to derive Hermes' reserved API ports. */
export interface HermesApiPortAgent {
  /** Dashboard forward port (forward_ports[0]); never treated as reserved. */
  forwardPort: number;
  /** All host-forwarded ports declared by the manifest. */
  forward_ports?: number[];
  /** Health-probe target — the Hermes OpenAI-compatible API port. */
  healthProbe?: { port: number };
}

/**
 * Ports the Hermes OpenAI-compatible API / gateway occupies that must never
 * be reused as the NemoClaw browser dashboard port. Derived from the agent
 * manifest: the health-probe/API port plus any forward_ports other than the
 * dashboard forward port. The dashboard forward port itself is excluded — it
 * is the legitimate dashboard target, not a reserved API port.
 */
export function reservedHermesApiPorts(agent: HermesApiPortAgent): number[] {
  const reserved = new Set<number>();
  const dashboardForward = agent.forwardPort;
  for (const port of agent.forward_ports ?? []) {
    if (port !== dashboardForward) reserved.add(port);
  }
  if (agent.healthProbe?.port && agent.healthProbe.port !== dashboardForward) {
    reserved.add(agent.healthProbe.port);
  }
  return [...reserved].sort((a, b) => a - b);
}

/**
 * Reject an explicit dashboard port that collides with a reserved Hermes API
 * port. No-op for non-Hermes agents, when no explicit port was requested
 * (auto-allocation), or when the agent definition is unavailable. Calls
 * `fail` (which is expected to never return — e.g. process.exit / throw) with
 * the operator-facing security message when a collision is detected.
 */
export function assertDashboardPortNotReservedForHermesApi({
  agentName,
  dashboardPort,
  agent,
  fail,
}: {
  agentName: string | null | undefined;
  dashboardPort: number | null | undefined;
  agent: HermesApiPortAgent | null | undefined;
  fail: (message: string) => never;
}): void {
  if (agentName !== "hermes") return;
  if (dashboardPort == null || !agent) return;
  if (reservedHermesApiPorts(agent).includes(dashboardPort)) {
    fail(
      `[SECURITY] Invalid Hermes dashboard port ${dashboardPort} - reserved for the Hermes OpenAI-compatible API.`,
    );
  }
}
