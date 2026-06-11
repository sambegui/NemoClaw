// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTerminalAgent } from "../agent/defs";
import { DASHBOARD_PORT } from "../core/ports";

type RunCaptureOpenshell = (args: string[], options: { ignoreError: true }) => string;
type RegistryReader = {
  getSandbox(sandboxName: string): { dashboardPort?: number | null } | null | undefined;
};

export type DashboardRuntimeAgent = {
  forwardPort?: number | null;
  forward_ports?: number[] | null;
  runtime?: { kind?: unknown } | null;
} | null;

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

export function isValidForwardPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function getAgentDeclaredForwardPorts(agent: DashboardRuntimeAgent): number[] {
  if (!agent) return [];
  return [
    agent.forwardPort,
    ...(Array.isArray(agent.forward_ports) ? agent.forward_ports : []),
  ].filter((port, index, ports): port is number => {
    return isValidForwardPort(port) && ports.indexOf(port) === index;
  });
}

export function getAgentPrimaryForwardPort(agent: DashboardRuntimeAgent, fallback: number): number {
  return isValidForwardPort(agent?.forwardPort) ? agent.forwardPort : fallback;
}

function parseChatUiUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return null;
  }
}

function getParsedUrlPort(url: URL | null): number | null {
  const port = Number(url?.port);
  return isValidForwardPort(port) ? port : null;
}

export function shouldManageDashboardForAgent(agent: DashboardRuntimeAgent): boolean {
  if (!agent || !isTerminalAgent(agent)) return true;
  return getAgentDeclaredForwardPorts(agent).length > 0;
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
  agent: DashboardRuntimeAgent;
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

  const rawPersistedPort = registry.getSandbox(sandboxName)?.dashboardPort ?? null;
  const persistedPort = isValidForwardPort(rawPersistedPort) ? rawPersistedPort : null;
  const parsedChatUiUrl = parseChatUiUrl(env.CHAT_UI_URL);
  const envPort = getParsedUrlPort(parsedChatUiUrl);

  const preferredPort =
    controlUiPort ?? envPort ?? persistedPort ?? getAgentPrimaryForwardPort(agent, DASHBOARD_PORT);
  const earlyForwards = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  const effectivePort = findAvailableDashboardPort(sandboxName, preferredPort, earlyForwards);
  if (effectivePort !== preferredPort) {
    warn(`  ! Port ${preferredPort} is taken. Using port ${effectivePort} instead.`);
  }

  let chatUiUrl = `http://127.0.0.1:${effectivePort}`;
  if (parsedChatUiUrl && controlUiPort == null) {
    parsedChatUiUrl.port = String(effectivePort);
    chatUiUrl = parsedChatUiUrl.toString().replace(/\/$/, "");
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
