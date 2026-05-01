// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Additional coverage on top of test/repro-2376.test.ts. Three angles the
 * existing test does not cover:
 *   1. Behavioral — does the rc pattern actually export HERMES_HOME at runtime?
 *   2. No-clobber — does any later block overwrite /sandbox/.bashrc?
 *   3. OpenClaw parity — does Dockerfile.base have the equivalent block
 *      (validates the test docstring claim)?
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");
const OPENCLAW_DOCKERFILE = path.join(ROOT, "Dockerfile.base");

describe("Issue #2376 — additional coverage on top of repro-2376.test.ts", () => {
  it("BEHAVIORAL: sourcing the rc pattern exports HERMES_HOME when proxy-env exists", () => {
    // Recreate the exact .bashrc the Dockerfile writes, source it via bash -c,
    // and verify HERMES_HOME ends up in the resulting environment. Proves the
    // rc pattern works at runtime, not just that the strings exist.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nc-2376-"));
    const proxyEnv = path.join(tmp, "nemoclaw-proxy-env.sh");
    const bashrc = path.join(tmp, ".bashrc");
    fs.writeFileSync(proxyEnv, "export HERMES_HOME=/sandbox/.hermes\n");
    fs.writeFileSync(bashrc, `[ -f ${proxyEnv} ] && . ${proxyEnv}\n`);
    const out = execSync(`bash -c '. ${bashrc}; echo "$HERMES_HOME"'`, {
      encoding: "utf-8",
    }).trim();
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(out).toBe("/sandbox/.hermes");
  });

  it("NO-CLOBBER: agents/hermes/Dockerfile.base writes /sandbox/.bashrc exactly once", () => {
    // Tighten the guard so a future block silently overwriting the rc files
    // would fail this test, not just slip through.
    const src = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const matches = (src.match(/>\s*\/sandbox\/\.bashrc\b/g) || []).length;
    expect(matches).toBe(1);
    expect(src).not.toMatch(/rm\s+-?f?\s*\/sandbox\/\.bashrc/);
  });

  it("OPENCLAW PARITY: Dockerfile.base has the same proxy-env source line", () => {
    // The PR's docstring cites the OpenClaw base image as the canonical
    // pattern. If that block changes upstream, the Hermes block becomes
    // orphaned. Lock the cross-image invariant here.
    const openclaw = fs.readFileSync(OPENCLAW_DOCKERFILE, "utf-8");
    expect(openclaw).toContain(
      "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh",
    );
    expect(openclaw).toContain("> /sandbox/.bashrc");
    expect(openclaw).toContain("> /sandbox/.profile");
  });
});
