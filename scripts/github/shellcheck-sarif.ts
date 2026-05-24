// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Finds shell scripts, runs ShellCheck, and writes Code Scanning SARIF. */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setOutput } from "./lib/actions.ts";
import { runCapture } from "./lib/exec.ts";
import { emptySarif, shellcheckJsonToSarif, type ShellCheckJson } from "./lib/shellcheck-sarif.ts";
import { isMainModule } from "./lib/module.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHELLCHECK_JSON_PATH = "shellcheck.json";
const SHELLCHECK_SARIF_PATH = "shellcheck.sarif";
const SHELL_FILES_PATH = "shell-files.txt";

function listShellFiles(): string[] {
  const result = runCapture("git", ["ls-files", "*.sh", "install.sh", "uninstall.sh"], REPO_ROOT);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed:\n${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function parseShellcheckJson(stdout: string): ShellCheckJson | undefined {
  try {
    return JSON.parse(stdout) as ShellCheckJson;
  } catch {
    return undefined;
  }
}

function main(): void {
  const files = listShellFiles();
  writeFileSync(path.join(REPO_ROOT, SHELL_FILES_PATH), `${files.join("\n")}\n`, "utf-8");
  setOutput("has_files", files.length > 0);

  if (files.length === 0) {
    writeFileSync(
      path.join(REPO_ROOT, SHELLCHECK_SARIF_PATH),
      `${JSON.stringify(emptySarif(), null, 2)}\n`,
    );
    setOutput("has_runs", false);
    return;
  }

  const shellcheck = runCapture("shellcheck", ["--format=json1", ...files], REPO_ROOT);
  writeFileSync(path.join(REPO_ROOT, SHELLCHECK_JSON_PATH), shellcheck.stdout, "utf-8");

  const parsed = parseShellcheckJson(shellcheck.stdout);
  if (parsed) {
    const sarif = shellcheckJsonToSarif(parsed);
    writeFileSync(
      path.join(REPO_ROOT, SHELLCHECK_SARIF_PATH),
      `${JSON.stringify(sarif, null, 2)}\n`,
    );
    setOutput("has_runs", sarif.runs.length > 0);
  } else {
    console.log(
      `ShellCheck produced invalid JSON (exit=${shellcheck.status}); writing empty SARIF fallback.`,
    );
    writeFileSync(
      path.join(REPO_ROOT, SHELLCHECK_SARIF_PATH),
      `${JSON.stringify(emptySarif(), null, 2)}\n`,
    );
    setOutput("has_runs", false);
  }

  if (shellcheck.status !== 0) {
    console.log(
      `ShellCheck reported findings (exit=${shellcheck.status}); continuing so SARIF can be uploaded.`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
