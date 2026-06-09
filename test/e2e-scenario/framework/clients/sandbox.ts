// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import { artifactLabel, assertExitZero, type CommandRunner } from "./command.ts";

export interface SandboxClientOptions {
  openshellPath?: string;
}

export class SandboxClient {
  private readonly runner: CommandRunner;
  private readonly openshellPath: string;

  constructor(runner: CommandRunner, options: SandboxClientOptions = {}) {
    this.runner = runner;
    this.openshellPath = options.openshellPath ?? process.env.OPENSHELL_BIN ?? "openshell";
  }

  openshell(args: string[] = [], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.runner.run(
      trustedShellCommand({
        command: this.openshellPath,
        args,
        reason: "run OpenShell sandbox command",
      }),
      {
        artifactName: `openshell-${artifactLabel(args.join("-") || "default")}`,
        ...options,
      },
    );
  }

  list(): Promise<ShellProbeResult> {
    return this.openshell(["sandbox", "list"], { artifactName: "sandbox-list" });
  }

  status(name: string): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "status", name], { artifactName: `sandbox-status-${name}` });
  }

  exec(name: string, command: string[], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "exec", name, "--", ...command], {
      artifactName: `sandbox-exec-${name}`,
      ...options,
    });
  }

  async expectRunning(name: string): Promise<ShellProbeResult> {
    const result = await this.status(name);
    assertExitZero(result, `openshell sandbox status ${name}`);
    return result;
  }

  /**
   * Assert the named sandbox was not created — the negative-scenario
   * counterpart to `expectRunning`. Mirrors the `sandbox-absent` probe: it
   * fails closed if `openshell sandbox list` reports the sandbox, so a
   * preflight/onboarding failure that leaks a sandbox is caught.
   */
  async expectAbsent(name: string): Promise<ShellProbeResult> {
    validateSandboxName(name);
    const result = await this.list();
    const present = new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|$)`, "m").test(result.stdout);
    if (present) {
      throw new Error(`expected sandbox '${name}' to be absent, but \`openshell sandbox list\` reports it`);
    }
    return result;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateSandboxName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`sandbox name is invalid for fixture client: ${name}`);
  }
}
