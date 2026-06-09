// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import { type CommandRunner } from "./command.ts";

export interface RepoClientOptions {
  repoRoot?: string;
  installScript?: string;
  bashPath?: string;
}

// Installing from source is npm install + CLI build + plugin build + link,
// which is minutes of work on a cold cache. Give it a generous default so the
// fixture does not kill a legitimately slow install.
const DEFAULT_INSTALL_TIMEOUT_MS = 900_000;

/**
 * Wraps the production `install.sh` for repo-source installs.
 *
 * Per the Fixture Subprocess Rule we do NOT reimplement install-time bash in
 * TypeScript: `installCurrent()` spawns the real `install.sh` in bash and lets
 * its source-checkout branch (triggered by `NEMOCLAW_REPO_ROOT` / a `.git`
 * directory) install from the current clone.
 */
export class RepoClient {
  private readonly runner: CommandRunner;
  private readonly repoRoot: string;
  private readonly installScript: string;
  private readonly bashPath: string;

  constructor(runner: CommandRunner, options: RepoClientOptions = {}) {
    this.runner = runner;
    this.repoRoot = options.repoRoot ?? process.env.NEMOCLAW_REPO_ROOT ?? process.cwd();
    this.installScript = options.installScript ?? path.join(this.repoRoot, "install.sh");
    this.bashPath = options.bashPath ?? "bash";
  }

  /**
   * Install NemoClaw from the current repo checkout by running the real
   * `install.sh`. `NEMOCLAW_REPO_ROOT` is exported so the installer resolves
   * the source checkout deterministically instead of cloning a release ref.
   */
  installCurrent(options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.runner.run(
      trustedShellCommand({
        command: this.bashPath,
        args: [this.installScript],
        reason: "install NemoClaw from the current repo checkout",
      }),
      {
        artifactName: "repo-install-current",
        cwd: this.repoRoot,
        inheritEnv: true,
        env: { NEMOCLAW_REPO_ROOT: this.repoRoot },
        timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
        ...options,
      },
    );
  }
}
