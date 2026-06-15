// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  evaluateDiagnosticBudget,
  formatViolations,
  parseBudget,
} from "../scripts/check-biome-diagnostic-budget";

describe("Biome diagnostic budget", () => {
  it("parses budget entries", () => {
    expect(
      parseBudget(
        JSON.stringify({
          budgets: [
            {
              name: "skipped tests",
              selector: "noSkippedTests",
              maxDiagnostics: 3,
            },
          ],
        }),
      ),
    ).toEqual({
      budgets: [
        {
          name: "skipped tests",
          selector: "noSkippedTests",
          maxDiagnostics: 3,
        },
      ],
    });
  });

  it("rejects duplicate selectors", () => {
    expect(() =>
      parseBudget(
        JSON.stringify({
          budgets: [
            { name: "a", selector: "noSkippedTests", maxDiagnostics: 1 },
            { name: "b", selector: "noSkippedTests", maxDiagnostics: 1 },
          ],
        }),
      ),
    ).toThrow(/duplicate budget selector noSkippedTests/);
  });

  it("fails when diagnostics grow beyond the budget", () => {
    const violations = evaluateDiagnosticBudget([
      {
        name: "skipped tests",
        selector: "noSkippedTests",
        maxDiagnostics: 3,
        diagnostics: 4,
        examples: [
          {
            file: "test/example.test.ts",
            line: 10,
            category: "lint/suspicious/noSkippedTests",
            message: "Don't disable tests.",
          },
        ],
      },
    ]);

    expect(violations).toEqual([
      {
        kind: "over-budget",
        name: "skipped tests",
        selector: "noSkippedTests",
        diagnostics: 4,
        maxDiagnostics: 3,
        examples: [
          {
            file: "test/example.test.ts",
            line: 10,
            category: "lint/suspicious/noSkippedTests",
            message: "Don't disable tests.",
          },
        ],
      },
    ]);
    expect(formatViolations(violations)).toContain("4 diagnostic(s) > 3 budget");
    expect(formatViolations(violations)).toContain("test/example.test.ts:10");
  });

  it("requires the budget to ratchet down when diagnostics shrink", () => {
    const violations = evaluateDiagnosticBudget([
      {
        name: "skipped tests",
        selector: "noSkippedTests",
        maxDiagnostics: 3,
        diagnostics: 2,
        examples: [],
      },
    ]);

    expect(violations).toEqual([
      {
        kind: "legacy-ratchet",
        name: "skipped tests",
        selector: "noSkippedTests",
        diagnostics: 2,
        maxDiagnostics: 3,
      },
    ]);
    expect(formatViolations(violations)).toContain("lower maxDiagnostics");
  });

  it("passes when diagnostics match the budget", () => {
    expect(
      evaluateDiagnosticBudget([
        {
          name: "skipped tests",
          selector: "noSkippedTests",
          maxDiagnostics: 3,
          diagnostics: 3,
          examples: [],
        },
      ]),
    ).toEqual([]);
  });
});
