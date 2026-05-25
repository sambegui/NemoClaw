// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PORT } from "../core/ports";
import { waitForHttp } from "../core/wait";

const { run, runShell }: typeof import("../runner") = require("../runner");
const {
  setResolvedOllamaHost,
}: typeof import("../inference/local") = require("../inference/local");

export interface InstallOllamaMacOSOptions {
  isNonInteractive: () => boolean;
  /** When true the running daemon is the upgrade target — pick `brew upgrade`
   *  and refuse to mask its failure with `ignoreError`. */
  isUpgrade?: boolean;
  runImpl?: typeof run;
  runShellImpl?: typeof runShell;
  waitForHttpImpl?: typeof waitForHttp;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export interface InstallOllamaMacOSResult {
  ok: boolean;
}

/**
 * Run the macOS install/upgrade via Homebrew, then launch the daemon on
 * loopback. Mirrors the structural contract of `installOllamaOnLinux` so the
 * onboard install-ollama branch can dispatch by platform with one call.
 *
 * When `isUpgrade` is set the Homebrew command must fail loudly: a silently
 * dropped `brew upgrade ollama` would leave the host on the stale daemon
 * and the subsequent version probe would still find the old binary.
 */
export function installOllamaOnMacOS(
  opts: InstallOllamaMacOSOptions,
): InstallOllamaMacOSResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  const runImpl = opts.runImpl ?? run;
  const runShellImpl = opts.runShellImpl ?? runShell;
  const waitForHttpImpl = opts.waitForHttpImpl ?? waitForHttp;

  const upgrade = Boolean(opts.isUpgrade);
  log(`  ${upgrade ? "Upgrading" : "Installing"} Ollama via Homebrew...`);
  runImpl(["brew", upgrade ? "upgrade" : "install", "ollama"], { ignoreError: !upgrade });

  log("  Starting Ollama...");
  runShellImpl(`OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} ollama serve > /dev/null 2>&1 &`, {
    ignoreError: true,
  });
  if (!waitForHttpImpl(`http://127.0.0.1:${OLLAMA_PORT}/`, 10)) {
    errorLog(`  Ollama did not become ready on :${OLLAMA_PORT} within timeout.`);
    return { ok: false };
  }
  // Pin to local loopback so any stale resolved host is overwritten.
  setResolvedOllamaHost("127.0.0.1");
  return { ok: true };
}
