// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Emits changed Markdown/MDX files for docs-only PR checks. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv, setOutput } from "./lib/actions.ts";
import { runCapture } from "./lib/exec.ts";
import { isMainModule } from "./lib/module.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_DIFF_PATHS = [
  "*.md",
  "*.mdx",
  ":(exclude)node_modules/**",
  ":(exclude)dist/**",
  ":(exclude)vendor/**",
  ":(exclude)build/**",
] as const;

export function listChangedDocumentationFiles(
  base: string,
  head: string,
  cwd = REPO_ROOT,
): string[] {
  const result = runCapture(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--", ...DOC_DIFF_PATHS],
    cwd,
  );
  if (result.status !== 0) {
    throw new Error(`git diff failed:\n${result.stderr}`);
  }
  return [...new Set(result.stdout.split("\n").filter(Boolean))].sort();
}

function main(): void {
  const files = listChangedDocumentationFiles(requireEnv("BASE_SHA"), requireEnv("HEAD_SHA"));
  setOutput("has_files", files.length > 0);
  if (files.length > 0) {
    setOutput("files", files.join("\n"));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
