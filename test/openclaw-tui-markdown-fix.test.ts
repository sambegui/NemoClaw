// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const START_SCRIPT = path.join(REPO_ROOT, "scripts", "nemoclaw-start.sh");
const PRELOAD_SOURCE = path.join(
  REPO_ROOT,
  "nemoclaw-blueprint",
  "scripts",
  "openclaw-tui-markdown-fix.js",
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __testing } = require(PRELOAD_SOURCE);

// A `marked`-shaped module whose renderer reproduces the NemoClaw#4849 bug:
// emphasis (`__x__`, `_x_`) is stripped from code token text before output.
function makeBuggyMarked() {
  const stripEmphasis = (s: string) =>
    String(s)
      .replace(/__(.+?)__/g, "$1")
      .replace(/_([^_]+?)_/g, "$1");
  const uses: unknown[] = [];
  class Renderer {
    codespan(token: { text: string }) {
      return stripEmphasis(token.text);
    }
    code(token: { text: string }) {
      return stripEmphasis(token.text);
    }
  }
  return {
    module: { Renderer, use: (ext: unknown) => uses.push(ext) },
    uses,
    Renderer,
  };
}

describe("openclaw-tui-markdown-fix preload (NemoClaw#4849)", () => {
  const DUNDER = 'if __name__ == "__main__":';
  const FUNC = "def is_palindrome(s: str) -> bool:";

  it("baseline buggy renderer corrupts dunders and underscores (fixture sanity)", () => {
    const { Renderer } = makeBuggyMarked();
    expect(new Renderer().codespan({ text: DUNDER })).toBe('if name == "main":');
    // A single-underscore identifier loses its underscore too.
    expect(new Renderer().code({ text: FUNC })).not.toContain("is_palindrome");
  });

  it("renders inline code spans verbatim after patching", () => {
    const { module, Renderer } = makeBuggyMarked();
    __testing.applyMarkdownCodeFix(module);
    expect(new Renderer().codespan({ text: DUNDER })).toBe(DUNDER);
  });

  it("renders fenced code blocks verbatim after patching", () => {
    const { module, Renderer } = makeBuggyMarked();
    __testing.applyMarkdownCodeFix(module);
    expect(new Renderer().code({ text: FUNC, lang: "python" })).toBe(FUNC);
    expect(new Renderer().code({ text: `${FUNC}\n    return s == s[::-1]` })).toContain(
      "is_palindrome",
    );
  });

  it("registers a marked.use() renderer override for the parse() path", () => {
    const { module, uses } = makeBuggyMarked();
    __testing.applyMarkdownCodeFix(module);
    expect(uses).toHaveLength(1);
    const renderer = (uses[0] as { renderer?: Record<string, unknown> }).renderer ?? {};
    expect(typeof renderer.code).toBe("function");
    expect(typeof renderer.codespan).toBe("function");
  });

  it("derives verbatim text from token.text, token.raw, or a raw string", () => {
    expect(__testing.verbatimCodeText({ text: DUNDER })).toBe(DUNDER);
    expect(__testing.verbatimCodeText({ raw: `\`${DUNDER}\`` })).toBe(`\`${DUNDER}\``);
    expect(__testing.verbatimCodeText(DUNDER)).toBe(DUNDER);
    expect(__testing.verbatimCodeText(null)).toBe("");
  });

  it("is idempotent and does not re-patch an already-patched module", () => {
    const { module, Renderer } = makeBuggyMarked();
    __testing.applyMarkdownCodeFix(module);
    const firstCodespan = Renderer.prototype.codespan;
    __testing.applyMarkdownCodeFix(module);
    expect(Renderer.prototype.codespan).toBe(firstCodespan);
    expect(new Renderer().codespan({ text: DUNDER })).toBe(DUNDER);
  });

  it("leaves plain (non-code) text rendering untouched", () => {
    // The patch only replaces code/codespan; other renderer methods survive so
    // bold/italic outside code blocks keeps working.
    const { module } = makeBuggyMarked();
    (module.Renderer.prototype as Record<string, unknown>).strong = (t: { text: string }) =>
      `**${t.text}**`;
    __testing.applyMarkdownCodeFix(module);
    expect(typeof (module.Renderer.prototype as Record<string, unknown>).strong).toBe(
      "function",
    );
  });
});

// Extract the sandbox-side `openclaw()` guard from the single-quoted heredoc so
// we can exercise the `tui` branch without a live sandbox.
function extractGuardFunction(src: string): string {
  const begin = src.indexOf("# nemoclaw-configure-guard begin");
  const end = src.indexOf("# nemoclaw-configure-guard end");
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("Expected nemoclaw-configure-guard markers in scripts/nemoclaw-start.sh");
  }
  return src.slice(begin, end);
}

describe("openclaw() TUI markdown-fix injection (NemoClaw#4849)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const guard = extractGuardFunction(src);

  function runGuard(
    args: string[],
    opts: { preloadPresent?: boolean } = {},
  ): { status: number; stdout: string; stderr: string; preloadPath: string } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tui-md-"));
    try {
      const binDir = path.join(tempDir, "bin");
      fs.mkdirSync(binDir);
      fs.writeFileSync(
        path.join(binDir, "openclaw"),
        [
          "#!/usr/bin/env bash",
          'echo "FAKE_OPENCLAW_ARGS=$*"',
          'echo "FAKE_OPENCLAW_NODE_OPTIONS=${NODE_OPTIONS:-}"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const preloadPath = path.join(tempDir, "nemoclaw-openclaw-tui-markdown-fix.js");
      if (opts.preloadPresent) fs.writeFileSync(preloadPath, "// stub preload\n");

      // The guard body hardcodes the literal /tmp path (single-quoted heredoc);
      // redirect it to the temp file for the test.
      const guardBody = guard.replaceAll(
        "/tmp/nemoclaw-openclaw-tui-markdown-fix.js",
        preloadPath,
      );

      const wrapperPath = path.join(tempDir, "run.sh");
      fs.writeFileSync(
        wrapperPath,
        [
          "#!/usr/bin/env bash",
          `export PATH=${JSON.stringify(binDir)}:"$PATH"`,
          guardBody,
          `openclaw ${args.map((a) => JSON.stringify(a)).join(" ")}`,
          'echo "GUARD_EXIT=$?"',
        ].join("\n"),
        { mode: 0o700 },
      );

      const r = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 10000 });
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        preloadPath,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("injects the markdown-fix preload into NODE_OPTIONS for `openclaw tui`", () => {
    const r = runGuard(["tui"], { preloadPresent: true });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=tui");
    expect(r.stdout).toContain(`--require ${r.preloadPath}`);
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("runs `openclaw tui` even if the preload file is absent (older base image)", () => {
    const r = runGuard(["tui"], { preloadPresent: false });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=tui");
    expect(r.stdout).not.toContain("--require");
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("does not inject the preload for non-TUI commands", () => {
    const r = runGuard(["doctor"], { preloadPresent: true });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=doctor");
    expect(r.stdout).not.toContain("--require");
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });
});
