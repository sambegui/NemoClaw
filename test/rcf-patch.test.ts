// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const PATCH_SCRIPT = path.join(REPO_ROOT, "scripts", "rcf_patch.py");

function runPatch(source: string, env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rcf-patch-"));
  const file = path.join(dir, "mutate.js");
  fs.writeFileSync(file, source);
  try {
    const result = spawnSync("python3", [PATCH_SCRIPT, file], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 5000,
    });
    return {
      result,
      patched: fs.readFileSync(file, "utf-8"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function replaceConfigFileBody(properties: string) {
  return `
async function replaceConfigFile(params) {
  const snapshot = params.snapshot;
  const writeOptions = params.writeOptions ?? {};
  if (! await tryWriteSingleTopLevelIncludeMutation({
${properties}
  })) await writeConfigFile(params.nextConfig, {
    baseSnapshot: snapshot,
    ...writeOptions,
    ...params.writeOptions
  });
}
`;
}

describe("rcf_patch.py", () => {
  it("patches replaceConfigFile with either snapshot/nextConfig property order", () => {
    for (const properties of [
      "    snapshot,\n    nextConfig: params.nextConfig",
      "    nextConfig: params.nextConfig,\n    snapshot",
    ]) {
      const { result, patched } = runPatch(replaceConfigFileBody(properties));
      expect(result.status).toBe(0);
      expect(patched).toContain("OPENSHELL_SANDBOX");
      expect(patched).toContain("try { if (!await tryWriteSingleTopLevelIncludeMutation");
    }
  });

  it("ignores braces inside strings and comments when locating replaceConfigFile", () => {
    const { result, patched } = runPatch(`
async function replaceConfigFile(params) {
  const stringBrace = "}";
  // comment brace: }
  /* block comment brace: } */
  const snapshot = params.snapshot;
  const writeOptions = params.writeOptions ?? {};
  if (!await tryWriteSingleTopLevelIncludeMutation({
    nextConfig: params.nextConfig,
    snapshot
  })) await writeConfigFile(params.nextConfig, {
    baseSnapshot: snapshot,
    ...writeOptions,
    ...params.writeOptions
  });
}
`);

    expect(result.status).toBe(0);
    expect(patched).toContain('const stringBrace = "}";');
    expect(patched).toContain("comment brace: }");
    expect(patched).toContain("OPENSHELL_SANDBOX");
  });

  it("soft-warns and leaves the source untouched when replaceConfigFile lacks the expected write block", () => {
    const original = `
async function replaceConfigFile(params) {
  await writeConfigFile(params.nextConfig, {});
}
`;
    const { result, patched } = runPatch(original);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("tryWriteSingleTopLevelIncludeMutation/writeConfigFile pattern not found");
    expect(result.stderr).toContain("plugins still load via auto-discovery");
    expect(patched).toBe(original);
  });

  it("soft-warns and leaves the source untouched when the replaceConfigFile function itself is missing", () => {
    const original = "// no replaceConfigFile here\n";
    const { result, patched } = runPatch(original);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("replaceConfigFile function not found");
    expect(patched).toBe(original);
  });

  it("skips entirely (no patch, no warn) when OPENCLAW_VERSION is past the known-broken sentinel", () => {
    const original = replaceConfigFileBody("    snapshot,\n    nextConfig: params.nextConfig");
    const { result, patched } = runPatch(original, { OPENCLAW_VERSION: "99999.0.0" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("past the last known-broken version");
    expect(patched).toBe(original);
    expect(patched).not.toContain("OPENSHELL_SANDBOX");
  });

  it("still applies the patch for the current bundled OpenClaw version (well below the sentinel)", () => {
    const { result, patched } = runPatch(
      replaceConfigFileBody("    snapshot,\n    nextConfig: params.nextConfig"),
      { OPENCLAW_VERSION: "2026.4.24" },
    );

    expect(result.status).toBe(0);
    expect(patched).toContain("OPENSHELL_SANDBOX");
  });

  it("still applies the patch when OPENCLAW_VERSION is missing or unparseable", () => {
    for (const env of [{}, { OPENCLAW_VERSION: "" }, { OPENCLAW_VERSION: "not-a-version" }]) {
      const { result, patched } = runPatch(
        replaceConfigFileBody("    snapshot,\n    nextConfig: params.nextConfig"),
        env,
      );
      expect(result.status).toBe(0);
      expect(patched).toContain("OPENSHELL_SANDBOX");
    }
  });
});
