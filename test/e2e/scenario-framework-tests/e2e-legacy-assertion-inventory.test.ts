// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { loadMetadataFromDir, loadMetadataFromObjects } from "../runtime/resolver/load.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e");
const SPEC_PATH = path.join(
  REPO_ROOT,
  "specs/2026-05-26_issue-3816-platform-remote-scenario-suites/spec.md",
);

const PLACEHOLDER_IDS = new Set([
  "expected.platform_remote.*",
  "expected.platform_remote.<family>.<behavior>",
]);

function platformRemoteIdsFromSpec(): Set<string> {
  const spec = fs.readFileSync(SPEC_PATH, "utf8");
  const ids = new Set<string>();
  for (const match of spec.matchAll(/`(expected\.platform_remote\.[^`]+)`/g)) {
    const id = match[1];
    if (!PLACEHOLDER_IDS.has(id)) {
      ids.add(id);
    }
  }
  return ids;
}

describe("Issue #3816 legacy platform/remote assertion inventory", () => {
  it("test_should_represent_every_platform_remote_inventory_row", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const rows = meta.scenarios.platform_remote_inventory ?? [];
    const expectedIds = platformRemoteIdsFromSpec();
    const idRows = rows.filter((row) => row.id);
    const actualIds = idRows.map((row) => row.id as string);
    const duplicates = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
    const missing = [...expectedIds].filter((id) => !actualIds.includes(id));
    const unexpected = actualIds.filter((id) => !expectedIds.has(id));

    expect(duplicates, `duplicate platform_remote ids:\n${duplicates.join("\n")}`).toEqual([]);
    expect(missing, `missing spec ids:\n${missing.join("\n")}`).toEqual([]);
    expect(unexpected, `unexpected platform_remote ids:\n${unexpected.join("\n")}`).toEqual([]);

    for (const row of rows) {
      expect(["covered", "new assertion", "deferred", "retired"]).toContain(row.classification);
    }
    expect(rows.some((row) => row.classification === "retired" && row.inventory_key)).toBe(true);
  });

  it("test_should_reject_inventory_simplification_that_merges_granular_rows", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const rows = meta.scenarios.platform_remote_inventory ?? [];
    const collapsedRows = rows.filter(
      (row) =>
        row.id !== "expected.platform_remote.ollama_proxy.token-mode-600" &&
        row.id !== "expected.platform_remote.ollama_proxy.rejects-unauthenticated",
    );

    expect(() =>
      loadMetadataFromObjects({
        scenarios: {
          ...meta.scenarios,
          platform_remote_inventory: collapsedRows,
        },
        expectedStates: meta.expectedStates,
        suites: meta.suites,
      }),
    ).not.toThrow();

    const actualIds = new Set(collapsedRows.map((row) => row.id).filter(Boolean));
    const missing = [...platformRemoteIdsFromSpec()].filter((id) => !actualIds.has(id));
    expect(missing).toEqual(
      expect.arrayContaining([
        "expected.platform_remote.ollama_proxy.token-mode-600",
        "expected.platform_remote.ollama_proxy.rejects-unauthenticated",
      ]),
    );
  });

  it("test_should_mark_debug_cleanup_rows_retired", () => {
    const rows = loadMetadataFromDir(E2E_DIR).scenarios.platform_remote_inventory ?? [];
    for (const key of [
      "retired.pre-cleanup-complete",
      "retired.uninstall-skipped-with-skip-uninstall-1",
      "retired.cleanup-complete",
      "retired.cleanup-complete-keep-sandbox-skip",
    ]) {
      const row = rows.find((entry) => entry.inventory_key === key);
      expect(row, `missing ${key}`).toBeTruthy();
      expect(row?.classification).toBe("retired");
      expect(row?.execution_status).toBe("retired");
      expect(row?.rationale).toMatch(/Harness|cleanup|debug/i);
    }
  });
});
