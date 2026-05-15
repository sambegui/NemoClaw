// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseRestoreArgs,
  rejectHardLinks,
  safeTarExtract,
  validateSnapshotName,
  validateTarEntries,
} from "../../../dist/lib/state/sandbox";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function tarBufferFrom(dir: string): Buffer {
  return execFileSync("tar", ["-cf", "-", "-C", dir, "."]);
}

describe("sandbox state snapshot helpers", () => {
  it("validates user-provided snapshot names", () => {
    expect(validateSnapshotName("release_2026.05-rc1")).toBeNull();
    expect(validateSnapshotName("bad name")).toContain("Invalid snapshot name");
    expect(validateSnapshotName("v12")).toContain("conflicts with the auto-assigned version");
    expect(validateSnapshotName("-bad")).toContain("Invalid snapshot name");
  });

  it("parses restore selectors and target sandbox overrides", () => {
    expect(parseRestoreArgs("alpha", ["restore"])).toEqual({ ok: true, targetSandbox: "alpha", selector: null });
    expect(parseRestoreArgs("alpha", ["restore", "v2"])).toEqual({ ok: true, targetSandbox: "alpha", selector: "v2" });
    expect(parseRestoreArgs("alpha", ["restore", "snapshot-a", "--to", "beta"])).toEqual({
      ok: true,
      targetSandbox: "beta",
      selector: "snapshot-a",
    });
    expect(parseRestoreArgs("alpha", ["restore", "--to"])).toEqual({
      ok: false,
      error: "--to requires a target sandbox name.",
    });
    expect(parseRestoreArgs("alpha", ["restore", "--to", "--bad"])).toEqual({
      ok: false,
      error: "--to requires a target sandbox name.",
    });
  });

  it("validates and extracts safe tar archives", () => {
    const source = tempDir("nemoclaw-state-source-");
    const target = tempDir("nemoclaw-state-target-");
    writeFileSync(join(source, "config.json"), JSON.stringify({ ok: true }));
    const archive = tarBufferFrom(source);

    const validation = validateTarEntries(archive, target);
    expect(validation.safe).toBe(true);
    expect(validation.entries).toContain("./config.json");
    expect(rejectHardLinks(archive)).toEqual([]);

    expect(safeTarExtract(archive, target)).toEqual({ success: true });
    expect(existsSync(join(target, "config.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(target, "config.json"), "utf-8"))).toEqual({ ok: true });
  });

  it("rejects invalid tar buffers before extraction", () => {
    const target = tempDir("nemoclaw-state-bad-target-");
    const result = validateTarEntries(Buffer.from("not a tar"), target);
    expect(result.safe).toBe(false);
    expect(result.violations.join("\n")).toContain("tar listing failed");

    const extract = safeTarExtract(Buffer.from("not a tar"), target);
    expect(extract.success).toBe(false);
    expect(extract.error).toContain("tar entry validation failed");
  });
});
