// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for issue #3756: `snapshot restore --to <dst>` used to
// overwrite the destination silently when <dst> already existed. The new
// behaviour refuses by default and requires --force (with interactive confirm
// or --yes / NEMOCLAW_NON_INTERACTIVE=1) to delete-and-recreate the
// destination from the snapshot.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { execTimeout } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

type CliRunResult = { code: number; out: string };

function runCli(args: string, env: Record<string, string | undefined> = {}): CliRunResult {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "status" in err) {
      const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      const out = [e.stdout, e.stderr]
        .map((b) => (typeof b === "string" ? b : b ? b.toString("utf-8") : ""))
        .join("");
      return { code: typeof e.status === "number" ? e.status : 1, out };
    }
    return { code: 1, out: String(err) };
  }
}

/**
 * Build a temp HOME with:
 *  - registry containing `src` and `dst`
 *  - fake openshell that:
 *    - `sandbox list` reports BOTH `src` and `dst` as Ready
 *    - `status` reports the gateway as Connected
 *    - `sandbox delete` and `sandbox create` log every invocation to $OS_LOG
 *      so the test can assert what the action attempted
 *  - fake docker that:
 *    - `inspect ... State.Running` returns "true" (gateway up)
 */
function makeExistingDestEnv(prefix: string): {
  env: Record<string, string>;
  osLog: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });

  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        src: {
          name: "src",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        dst: {
          name: "dst",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: "src",
    }),
    { mode: 0o600 },
  );

  const osLog = path.join(home, "openshell.log");

  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(osLog)}`,
      'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
      '  printf "NAME STATUS\\nsrc Ready\\ndst Ready\\n"',
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ]; then',
      '  printf "Status: Connected\\n"',
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "create" ]; then',
      // Intentional non-zero: the test only needs to confirm delete fired
      // and create was reached; not exercising the full create stream.
      '  echo "fake-openshell: sandbox create not mocked end-to-end" >&2',
      "  exit 1",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/bin/sh",
      'if [ "$1" = "inspect" ]; then',
      '  echo "true"',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    env: {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH ?? ""}`,
    },
    osLog,
  };
}

describe("snapshot restore --to existing destination (#3756)", () => {
  it("refuses by default when the destination sandbox already exists", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-refuse-");
    const r = runCli("src snapshot restore --to dst", env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Destination sandbox 'dst' already exists/);
    expect(r.out).toMatch(/Re-run with --force/);
    // Critically, no delete is attempted in the refuse path.
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).not.toMatch(/sandbox delete dst/);
  });

  it("deletes the destination when --force --yes is set, then proceeds (#3756)", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-force-");
    const r = runCli("src snapshot restore --to dst --force --yes", env);
    // Auto-create is intentionally mocked to fail end-to-end here; the test
    // only proves the new --force branch ran through the delete step.
    expect(r.out).toMatch(/Deleting existing destination 'dst'/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).toMatch(/sandbox delete dst/);
  });

  it("skips the prompt under NEMOCLAW_NON_INTERACTIVE=1 even without --yes", () => {
    const base = makeExistingDestEnv("nemoclaw-snap-restore-noninteractive-");
    const env = { ...base.env, NEMOCLAW_NON_INTERACTIVE: "1" };
    const r = runCli("src snapshot restore --to dst --force", env);
    expect(r.out).toMatch(/Deleting existing destination 'dst'/);
    const log = fs.existsSync(base.osLog) ? fs.readFileSync(base.osLog, "utf-8") : "";
    expect(log).toMatch(/sandbox delete dst/);
  });
});
