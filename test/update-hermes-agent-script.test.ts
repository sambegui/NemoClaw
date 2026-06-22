// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "update-hermes-agent.sh");

describe("scripts/update-hermes-agent.sh", () => {
  it("keeps installed-copy scanning explicit", () => {
    const src = fs.readFileSync(SCRIPT, "utf-8");

    expect(src).toContain("--update-installed-copies");
    expect(src).toContain("UPDATE_INSTALLED_COPIES=0");
    expect(src).toContain(
      "--rebuild)\n      DO_BUILD=1\n      DO_REBUILD=1\n      UPDATE_INSTALLED_COPIES=1",
    );
    expect(src).toMatch(
      /if \[\[ "\$UPDATE_INSTALLED_COPIES" == 1 \]\]; then[\s\S]*discover_installed_dockerfiles[\s\S]*else[\s\S]*Installed-copy scan skipped/,
    );
    expect(src).toMatch(
      /if \[\[ "\$UPDATE_INSTALLED_COPIES" == 1 \]\]; then[\s\S]*apply_dockerfile_pins "\$installed_df"[\s\S]*else[\s\S]*installed copies: skipped/,
    );
  });
});
