// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Child-process helpers for GitHub Actions utility scripts. */

import { spawnSync } from "node:child_process";

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export function runCapture(command: string, args: readonly string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runChecked(command: string, args: readonly string[], cwd?: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["inherit", "inherit", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const details = [
      `${command} ${args.join(" ")} failed`,
      `exit code: ${result.status ?? 1}`,
      ...(result.signal ? [`signal: ${result.signal}`] : []),
      ...(cwd ? [`cwd: ${cwd}`] : []),
      ...(result.stderr ? [`stderr:\n${result.stderr}`] : []),
    ];
    throw new Error(details.join("\n"));
  }
}
