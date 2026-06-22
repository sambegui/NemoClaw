// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("export-e2e-hosted-inference action contract", () => {
  const action = YAML.parse(
    readFileSync(".github/actions/export-e2e-hosted-inference/action.yaml", "utf8"),
  ) as {
    inputs?: Record<string, { description?: string }>;
    runs?: { steps?: Array<{ run?: string }> };
  };
  const run = action.runs?.steps?.[0]?.run ?? "";

  it("rejects multiline credentials before writing GITHUB_ENV", () => {
    expect(run).toContain("Hosted inference credentials must be single-line values");
    expect(run).toContain("*$'\\n'*");
    expect(run).toContain("*$'\\r'*");
    expect(run.indexOf("Hosted inference credentials must be single-line values")).toBeLessThan(
      run.indexOf('>> "${GITHUB_ENV}"'),
    );
  });

  it("documents the temporary NVIDIA_API_KEY alias inventory and removal condition", () => {
    const aliasDescription = action.inputs?.["nvidia-api-key"]?.description ?? "";
    expect(aliasDescription).toContain("Temporary compatibility alias");
    expect(aliasDescription).toContain("openclaw-skill-cli");
    expect(aliasDescription).toContain("channels-add-remove");
    expect(aliasDescription).toContain("Remove after those lanes migrate");
  });
});
