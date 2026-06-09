// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Constitution enforcement: the Fixture Subprocess Rule.
 *
 * Fixture clients and framework helpers wrap the real `nemoclaw` CLI as a
 * subprocess — they must never import the CLI's internal modules from
 * `src/lib/` (nor its compiled form under `dist/lib/`). A live scenario always
 * crosses the process boundary; module-level tests live in `test/cli/` and
 * `nemoclaw/src/`. This test greps the framework sources and fails the build
 * if any of them reach into the product's internals.
 */

const FRAMEWORK_DIR = path.resolve(import.meta.dirname, "../framework");

// Match an import / dynamic-import / require whose module specifier reaches
// into the CLI implementation (src/lib or its compiled dist/lib form).
const FORBIDDEN_IMPORT = /(?:from|import|require)\s*\(?\s*["'][^"']*\b(?:src|dist)\/lib\//;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Fixture Subprocess Rule", () => {
  const files = collectTsFiles(FRAMEWORK_DIR);

  it("discovers framework sources to lint", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [path.relative(FRAMEWORK_DIR, file), file] as const))(
    "framework/%s does not import the CLI internals from src/lib",
    (_rel, file) => {
      const source = fs.readFileSync(file, "utf8");
      const offenders = source
        .split("\n")
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => FORBIDDEN_IMPORT.test(line));

      expect(
        offenders,
        `${path.relative(FRAMEWORK_DIR, file)} must wrap the nemoclaw CLI subprocess, not import src/lib internals:\n` +
          offenders.map((o) => `  L${o.number}: ${o.line}`).join("\n"),
      ).toEqual([]);
    },
  );
});
