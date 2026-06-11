// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../core/ports";

export type EnsureDashboardForward = (
  sandboxName: string,
  chatUiUrl?: string,
  options?: {
    preserveSandboxPorts?: Array<number | string>;
    allowPortReallocation?: boolean;
  },
) => number;

export interface AgentDashboardForwardConfig {
  forwardPort?: number | null;
  forward_ports?: number[] | null;
  runtime?: { kind?: unknown } | null;
}

export function ensureAgentDashboardForward(options: {
  sandboxName: string;
  agent: AgentDashboardForwardConfig;
  ensureDashboardForward: EnsureDashboardForward;
  controlUiPort?: number;
  warn?: (message: string) => void;
}): number {
  const {
    sandboxName,
    agent,
    ensureDashboardForward,
    controlUiPort = DASHBOARD_PORT,
    warn = (message: string) => console.warn(message),
  } = options;
  const declaredPorts = Array.isArray(agent.forward_ports) ? agent.forward_ports : [];
  const rawForwardPort = agent.forwardPort;
  const configuredForwardPort =
    typeof rawForwardPort === "number" &&
    Number.isInteger(rawForwardPort) &&
    rawForwardPort >= 1 &&
    rawForwardPort <= 65535
      ? rawForwardPort
      : null;
  if (
    agent.runtime?.kind === "terminal" &&
    configuredForwardPort === null &&
    declaredPorts.length === 0
  ) {
    return 0;
  }

  const agentDashboardPort = configuredForwardPort ?? controlUiPort;
  const preservePorts = [...new Set([agentDashboardPort, ...declaredPorts])].filter(
    (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
  );
  const actualAgentDashboardPort = ensureDashboardForward(
    sandboxName,
    `http://127.0.0.1:${agentDashboardPort}`,
    { preserveSandboxPorts: preservePorts },
  );
  process.env.CHAT_UI_URL = `http://127.0.0.1:${actualAgentDashboardPort}`;

  const portsToPreserve = [...new Set([...preservePorts, actualAgentDashboardPort])];
  for (const port of preservePorts) {
    if (port === agentDashboardPort) continue;
    try {
      ensureDashboardForward(sandboxName, `http://127.0.0.1:${port}`, {
        preserveSandboxPorts: portsToPreserve,
        allowPortReallocation: false,
      });
    } catch (err) {
      warn(
        `  ! Could not start optional agent port forward ${port}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return actualAgentDashboardPort;
}
