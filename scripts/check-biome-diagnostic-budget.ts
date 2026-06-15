#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export type BiomeDiagnosticBudgetEntry = {
  readonly name: string;
  readonly selector: string;
  readonly maxDiagnostics: number;
};

export type BiomeDiagnosticBudget = {
  readonly budgets: readonly BiomeDiagnosticBudgetEntry[];
};

export type BiomeDiagnosticExample = {
  readonly file: string;
  readonly line: number;
  readonly category: string;
  readonly message: string;
};

export type BiomeDiagnosticCount = BiomeDiagnosticBudgetEntry & {
  readonly diagnostics: number;
  readonly examples: readonly BiomeDiagnosticExample[];
};

export type BiomeDiagnosticBudgetViolation =
  | {
      readonly kind: "over-budget";
      readonly name: string;
      readonly selector: string;
      readonly diagnostics: number;
      readonly maxDiagnostics: number;
      readonly examples: readonly BiomeDiagnosticExample[];
    }
  | {
      readonly kind: "legacy-ratchet";
      readonly name: string;
      readonly selector: string;
      readonly diagnostics: number;
      readonly maxDiagnostics: number;
    };

type CliOptions = {
  budgetPath: string;
  update: boolean;
};

type RawBiomeDiagnostic = {
  readonly category?: unknown;
  readonly message?: unknown;
  readonly location?: {
    readonly path?: unknown;
    readonly start?: {
      readonly line?: unknown;
    };
  };
};

type RawBiomeJsonReport = {
  readonly diagnostics?: unknown;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUDGET_PATH = path.join(REPO_ROOT, "ci", "biome-diagnostic-budget.json");
const DEFAULT_EXAMPLE_LIMIT = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

export function parseBudget(
  sourceText: string,
  filePath = DEFAULT_BUDGET_PATH,
): BiomeDiagnosticBudget {
  const parsed = JSON.parse(sourceText) as { readonly budgets?: unknown };
  if (!Array.isArray(parsed.budgets)) {
    throw new Error(`${filePath}: budgets must be an array`);
  }

  const seenSelectors = new Set<string>();
  const budgets = parsed.budgets.map((entry, index): BiomeDiagnosticBudgetEntry => {
    if (!isRecord(entry)) {
      throw new Error(`${filePath}: budgets[${String(index)}] must be an object`);
    }

    const name = assertNonEmptyString(entry.name, `${filePath}: budgets[${String(index)}].name`);
    const selector = assertNonEmptyString(
      entry.selector,
      `${filePath}: budgets[${String(index)}].selector`,
    );
    const maxDiagnostics = assertNonNegativeInteger(
      entry.maxDiagnostics,
      `${filePath}: budgets[${String(index)}].maxDiagnostics`,
    );

    if (seenSelectors.has(selector)) {
      throw new Error(`${filePath}: duplicate budget selector ${selector}`);
    }
    seenSelectors.add(selector);

    return { name, selector, maxDiagnostics };
  });

  return { budgets };
}

export function evaluateDiagnosticBudget(
  counts: readonly BiomeDiagnosticCount[],
): BiomeDiagnosticBudgetViolation[] {
  const violations: BiomeDiagnosticBudgetViolation[] = [];

  for (const count of counts) {
    if (count.diagnostics > count.maxDiagnostics) {
      violations.push({
        kind: "over-budget",
        name: count.name,
        selector: count.selector,
        diagnostics: count.diagnostics,
        maxDiagnostics: count.maxDiagnostics,
        examples: count.examples,
      });
      continue;
    }

    if (count.diagnostics < count.maxDiagnostics) {
      violations.push({
        kind: "legacy-ratchet",
        name: count.name,
        selector: count.selector,
        diagnostics: count.diagnostics,
        maxDiagnostics: count.maxDiagnostics,
      });
    }
  }

  return violations;
}

function exampleFromDiagnostic(diagnostic: RawBiomeDiagnostic): BiomeDiagnosticExample {
  return {
    file: typeof diagnostic.location?.path === "string" ? diagnostic.location.path : "<unknown>",
    line: typeof diagnostic.location?.start?.line === "number" ? diagnostic.location.start.line : 0,
    category: typeof diagnostic.category === "string" ? diagnostic.category : "<unknown>",
    message: typeof diagnostic.message === "string" ? diagnostic.message : "<no message>",
  };
}

function findBiomeBinary(rootDir: string): string {
  const binaryName = process.platform === "win32" ? "biome.cmd" : "biome";
  const localBinary = path.join(rootDir, "node_modules", ".bin", binaryName);
  if (existsSync(localBinary)) {
    return localBinary;
  }
  return binaryName;
}

export function countBiomeDiagnostics(
  entry: BiomeDiagnosticBudgetEntry,
  rootDir = REPO_ROOT,
): BiomeDiagnosticCount {
  const result = spawnSync(
    findBiomeBinary(rootDir),
    ["lint", ".", `--only=${entry.selector}`, "--reporter=json", "--max-diagnostics=none"],
    {
      cwd: rootDir,
      encoding: "utf-8",
    },
  );

  if (result.error) {
    throw result.error;
  }

  let report: RawBiomeJsonReport;
  try {
    report = JSON.parse(result.stdout) as RawBiomeJsonReport;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Failed to parse Biome JSON output for ${entry.selector}: ${message}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (!Array.isArray(report.diagnostics)) {
    throw new Error(`Biome JSON output for ${entry.selector} did not include diagnostics`);
  }

  const diagnostics = report.diagnostics as RawBiomeDiagnostic[];
  return {
    ...entry,
    diagnostics: diagnostics.length,
    examples: diagnostics.slice(0, DEFAULT_EXAMPLE_LIMIT).map(exampleFromDiagnostic),
  };
}

export function formatViolations(
  violations: readonly BiomeDiagnosticBudgetViolation[],
  budgetPath = "ci/biome-diagnostic-budget.json",
): string {
  const lines = [
    "Biome diagnostic budget failed.",
    "",
    `Budgets are configured in ${budgetPath}.`,
    "Fix the diagnostics, or ratchet maxDiagnostics down when a count shrinks.",
    "",
  ];

  for (const violation of violations) {
    if (violation.kind === "over-budget") {
      lines.push(
        `- ${violation.name} (${violation.selector}): ${violation.diagnostics} diagnostic(s) > ${violation.maxDiagnostics} budget`,
      );
      for (const example of violation.examples) {
        lines.push(
          `  - ${example.file}:${String(example.line)} ${example.category}: ${example.message}`,
        );
      }
    } else {
      lines.push(
        `- ${violation.name} (${violation.selector}): ${violation.diagnostics} diagnostic(s) < ${violation.maxDiagnostics} budget; lower maxDiagnostics`,
      );
    }
  }

  return lines.join("\n");
}

function renderBudget(budget: BiomeDiagnosticBudget): string {
  return `${JSON.stringify(
    {
      $comment:
        "SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\nSPDX-License-Identifier: Apache-2.0",
      budgets: budget.budgets,
    },
    null,
    2,
  )}\n`;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    budgetPath: DEFAULT_BUDGET_PATH,
    update: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--budget":
        if (!argv[index + 1] || argv[index + 1].startsWith("-")) {
          throw new Error("Missing value for --budget");
        }
        options.budgetPath = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--update":
        options.update = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run biome-budget:check -- [options]

Check Biome diagnostic counts against ratcheting budgets.

Options:
  --budget <path>   Budget JSON file (default: ci/biome-diagnostic-budget.json)
  --update          Rewrite maxDiagnostics to the current counts
  -h, --help        Show this help`);
}

export function main(argv = process.argv.slice(2)): void {
  try {
    const options = parseArgs(argv);
    const budget = parseBudget(readFileSync(options.budgetPath, "utf-8"), options.budgetPath);
    const counts = budget.budgets.map((entry) => countBiomeDiagnostics(entry));

    if (options.update) {
      const updatedBudget = {
        budgets: budget.budgets.map((entry) => {
          const count = counts.find((candidate) => candidate.selector === entry.selector);
          if (!count) {
            return entry;
          }
          return { ...entry, maxDiagnostics: count.diagnostics };
        }),
      };
      writeFileSync(options.budgetPath, renderBudget(updatedBudget));
      console.log(`Updated ${path.relative(REPO_ROOT, options.budgetPath)}.`);
      return;
    }

    const violations = evaluateDiagnosticBudget(counts);
    if (violations.length > 0) {
      console.error(formatViolations(violations, path.relative(REPO_ROOT, options.budgetPath)));
      process.exitCode = 1;
      return;
    }

    const summary = counts
      .map((count) => `${count.name}: ${String(count.diagnostics)}/${String(count.maxDiagnostics)}`)
      .join("; ");
    console.log(`Biome diagnostic budget passed: ${summary || "no budgets configured"}.`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

const THIS_FILE = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  main();
}
