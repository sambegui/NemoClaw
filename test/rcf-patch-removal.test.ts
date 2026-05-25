// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");

describe("removed replaceConfigFile patch QA guidance", () => {
  it("keeps the retired rcf_patch.py out of the repo and points QA at the supported checks", () => {
    const troubleshooting = fs.readFileSync(
      path.join(REPO_ROOT, "docs", "reference", "troubleshooting.mdx"),
      "utf-8",
    );

    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "rcf_patch.py"))).toBe(false);
    expect(
      fs.existsSync(path.join(REPO_ROOT, "nemoclaw-blueprint", "scripts", "rcf_patch.py")),
    ).toBe(false);
    expect(troubleshooting).toContain("`scripts/rcf_patch.py` is intentionally absent");
    expect(troubleshooting).toContain("The old Patch-4 fail-closed test no longer applies");
    expect(troubleshooting).toContain("nemoclaw <sandbox> shields up");
  });
});
