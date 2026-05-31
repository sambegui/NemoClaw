// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  startForwardBridgeDetached,
  stopForwardBridge,
} from "../adapters/openshell/forward-bridge-state";
import * as registry from "../state/registry";

type CommandResult = { status: number | null };

export interface AgentFixedForwardDeps {
  runOpenshell(args: string[], opts?: Record<string, unknown>): CommandResult;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
  openshellArgv(args: string[]): string[];
  cliName(): string;
  sleep(seconds: number): void;
}

function isValidPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

function resolveTargetPort(sandboxName: string, port: number): number {
  const sandbox = registry.getSandbox(sandboxName);
  if (
    sandbox?.agent === "hermes" &&
    sandbox.hermesDashboardEnabled === true &&
    sandbox.hermesDashboardPort === port &&
    isValidPort(sandbox.hermesDashboardInternalPort)
  ) {
    return sandbox.hermesDashboardInternalPort;
  }
  return port;
}

function resolveBindAddress(): string {
  return process.env.NEMOCLAW_DASHBOARD_BIND === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
}

export function ensureAgentFixedForward(
  deps: AgentFixedForwardDeps,
  sandboxName: string,
  port: number,
  label: string,
): boolean {
  stopForwardBridge(sandboxName, port);
  const { ok, diagnostic } = startForwardBridgeDetached(sandboxName, {
    bind: resolveBindAddress(),
    port,
    targetHost: "127.0.0.1",
    targetPort: resolveTargetPort(sandboxName, port),
    timeoutMs: 30_000,
  });
  if (!ok) {
    console.warn(
      `! ${label} forward on port ${port} did not start: ${diagnostic.slice(0, 240)}`,
    );
    console.warn(`  Reconnect after resolving the issue: ${deps.cliName()} ${sandboxName} connect`);
    return false;
  }
  return true;
}
