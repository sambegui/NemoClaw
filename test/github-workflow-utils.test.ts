// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { shellQuote, selectCsvJobs } from "../scripts/github/lib/actions.ts";
import { shellcheckJsonToSarif } from "../scripts/github/lib/shellcheck-sarif.ts";
import { extractPreviewUrl } from "../scripts/github/fern-preview.ts";
import { parseOutputMappings } from "../scripts/github/select-jobs.ts";
import { windowsPathToWsl } from "../scripts/github/wsl.ts";

describe("GitHub workflow utility helpers", () => {
  it("converts Windows checkout paths to WSL mount paths", () => {
    expect(windowsPathToWsl("D:\\a\\NemoClaw\\NemoClaw")).toBe("/mnt/d/a/NemoClaw/NemoClaw");
    expect(windowsPathToWsl("C:/Users/runneradmin/work/repo")).toBe(
      "/mnt/c/Users/runneradmin/work/repo",
    );
  });

  it("quotes single quotes for generated bash snippets", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("can't leak")).toBe("'can'\"'\"'t leak'");
  });

  it("selects all jobs for empty dispatch input and exact matches otherwise", () => {
    const mapping = parseOutputMappings([
      "dashboard=dashboard-remote-bind-e2e",
      "gateway=gateway-health-honest-e2e",
    ]);
    expect(Object.fromEntries(selectCsvJobs("", mapping))).toEqual({
      dashboard: true,
      gateway: true,
    });
    expect(Object.fromEntries(selectCsvJobs(" gateway-health-honest-e2e ", mapping))).toEqual({
      dashboard: false,
      gateway: true,
    });
  });

  it("converts shellcheck json1 comments to SARIF", () => {
    const sarif = shellcheckJsonToSarif({
      comments: [
        {
          file: "scripts/example.sh",
          line: 3,
          endLine: 3,
          column: 7,
          endColumn: 12,
          level: "warning",
          code: 2086,
          message: "Double quote to prevent globbing and word splitting.",
        },
      ],
    });

    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.rules[0].id).toBe("SC2086");
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "SC2086",
      level: "warning",
      message: { text: "Double quote to prevent globbing and word splitting." },
    });
  });

  it("extracts Fern preview URLs from CLI output", () => {
    expect(extractPreviewUrl("Published docs to https://preview.example.test/foo\n")).toBe(
      "https://preview.example.test/foo",
    );
    expect(extractPreviewUrl("no url here")).toBeUndefined();
  });
});
