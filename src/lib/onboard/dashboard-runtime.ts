// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTerminalAgent, type AgentDefinition } from "../agent/defs";
import { DASHBOARD_PORT } from "../core/ports";

type RunCaptureOpenshell = (args: string[], options: { ignoreError: true }) => string;
type RegistryReader = {
  getSandbox(sandboxName: string): { dashboardPort?: number | null } | null | undefined;
};

export type DashboardRuntimePlan = {
  manageDashboard: boolean;
  effectivePort: number;
  chatUiUrl: string;
};

export type DashboardEnvPlan = {
  envArgs: string[];
  effectiveDashboardPort: string;
};

export type DashboardForwardPlan = {
  port: number;
  chatUiUrl: string;
};

export function shouldManageDashboardForAgent(agent: AgentDefinition | null): boolean {
  if (!agent || !isTerminalAgent(agent)) return true;
  const ports = [
    agent.forwardPort,
    ...(Array.isArray(agent.forward_ports) ? agent.forward_ports : []),
  ];
  return ports.some((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
}

export function resolveDashboardRuntimePlan({
  agent,
  sandboxName,
  controlUiPort,
  env,
  registry,
  findAvailableDashboardPort,
  runCaptureOpenshell,
  warn,
}: {
  agent: AgentDefinition | null;
  sandboxName: string;
  controlUiPort: number | null;
  env: NodeJS.ProcessEnv;
  registry: RegistryReader;
  findAvailableDashboardPort: (
    sandboxName: string,
    preferredPort: number,
    forwardListOutput: string,
  ) => number;
  runCaptureOpenshell: RunCaptureOpenshell;
  warn: (message: string) => void;
}): DashboardRuntimePlan {
  const manageDashboard = shouldManageDashboardForAgent(agent);
  if (!manageDashboard) return { manageDashboard, effectivePort: 0, chatUiUrl: "" };

  const persistedPort = registry.getSandbox(sandboxName)?.dashboardPort ?? null;
  let envPort: number | null = null;
  if (env.CHAT_UI_URL) {
    try {
      const u = new URL(
        env.CHAT_UI_URL.includes("://") ? env.CHAT_UI_URL : `http://${env.CHAT_UI_URL}`,
      );
      const p = Number(u.port);
      if (p > 0) envPort = p;
    } catch {
      /* malformed URL — ignore */
    }
  }

  const preferredPort =
    controlUiPort ?? envPort ?? persistedPort ?? (agent ? agent.forwardPort : DASHBOARD_PORT);
  const earlyForwards = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  const effectivePort = findAvailableDashboardPort(sandboxName, preferredPort, earlyForwards);
  if (effectivePort !== preferredPort) {
    warn(`  ! Port ${preferredPort} is taken. Using port ${effectivePort} instead.`);
  }

  let chatUiUrl = `http://127.0.0.1:${effectivePort}`;
  if (env.CHAT_UI_URL && controlUiPort == null) {
    const parsed = new URL(
      env.CHAT_UI_URL.includes("://") ? env.CHAT_UI_URL : `http://${env.CHAT_UI_URL}`,
    );
    parsed.port = String(effectivePort);
    chatUiUrl = parsed.toString().replace(/\/$/, "");
  }
  return { manageDashboard, effectivePort, chatUiUrl };
}

export function resolveReusedDashboardForward({
  manageDashboard,
  sandboxName,
  chatUiUrl,
  ensureDashboardForward,
  env,
}: {
  manageDashboard: boolean;
  sandboxName: string;
  chatUiUrl: string;
  ensureDashboardForward: (sandboxName: string, chatUiUrl: string) => number;
  env: NodeJS.ProcessEnv;
}): DashboardForwardPlan {
  if (!manageDashboard) return { port: 0, chatUiUrl };
  const port = ensureDashboardForward(sandboxName, chatUiUrl);
  const updatedChatUiUrl = `http://127.0.0.1:${port}`;
  env.CHAT_UI_URL = updatedChatUiUrl;
  return { port, chatUiUrl: updatedChatUiUrl };
}

export function createDashboardEnvPlan({
  manageDashboard,
  chatUiUrl,
  getDashboardForwardPort,
  formatEnvAssignment,
}: {
  manageDashboard: boolean;
  chatUiUrl: string;
  getDashboardForwardPort: (chatUiUrl: string) => string;
  formatEnvAssignment: (name: string, value: string) => string;
}): DashboardEnvPlan {
  if (!manageDashboard) return { envArgs: [], effectiveDashboardPort: "0" };
  const effectiveDashboardPort = getDashboardForwardPort(chatUiUrl);
  return {
    envArgs: [
      formatEnvAssignment("CHAT_UI_URL", chatUiUrl),
      formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort),
    ],
    effectiveDashboardPort,
  };
}
