// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fern docs preview helpers used by GitHub Actions workflows. */

import { spawnSync } from "node:child_process";
import { requireEnv, setOutput } from "./lib/actions.ts";
import { runCapture } from "./lib/exec.ts";
import { isMainModule } from "./lib/module.ts";

const PREVIEW_MARKER = "<!-- fern-preview-docs -->";

export function extractPreviewUrl(output: string): string | undefined {
  return output.match(/Published docs to (https?:\/\/[^\s]+)/)?.[1];
}

function generatePreviewUrl(): void {
  const previewId = requireEnv("PREVIEW_ID");
  const result = spawnSync("fern", ["generate", "--docs", "--preview", "--id", previewId], {
    cwd: "fern",
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(combinedOutput);
  const previewUrl = extractPreviewUrl(combinedOutput);
  if (!previewUrl) {
    console.error("::error::Failed to generate preview URL. See fern output above.");
    process.exit(result.status ?? 1);
  }
  setOutput("preview_url", previewUrl);
}

function postPreviewComment(): void {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const prNumber = requireEnv("PR_NUMBER");
  const previewUrl = requireEnv("PREVIEW_URL");
  const body = `:herb: **Preview your docs:** <${previewUrl}>\n\n${PREVIEW_MARKER}`;
  const comments = runCapture("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`]);
  if (comments.status !== 0) {
    throw new Error(`Failed to list PR comments:\n${comments.stderr}`);
  }
  const existing = (JSON.parse(comments.stdout) as Array<{ id?: number; body?: string }>).find(
    (comment) => comment.body?.includes(PREVIEW_MARKER),
  );
  if (existing?.id !== undefined) {
    const update = runCapture("gh", [
      "api",
      `repos/${repo}/issues/comments/${existing.id}`,
      "-X",
      "PATCH",
      "-f",
      `body=${body}`,
    ]);
    if (update.status !== 0) {
      throw new Error(`Failed to update PR comment:\n${update.stderr}`);
    }
    return;
  }
  const create = runCapture("gh", [
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "-f",
    `body=${body}`,
  ]);
  if (create.status !== 0) {
    throw new Error(`Failed to create PR comment:\n${create.stderr}`);
  }
}

function main(): void {
  const command = process.argv[2];
  if (command === "generate-url") {
    generatePreviewUrl();
    return;
  }
  if (command === "post-comment") {
    postPreviewComment();
    return;
  }
  throw new Error(`Unknown fern-preview command: ${command ?? "<missing>"}`);
}

if (isMainModule(import.meta.url)) {
  main();
}
