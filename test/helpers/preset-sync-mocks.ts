// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared scaffolding for tests that exercise `policies.applyPreset` /
// `policies.applyPresetContent` / `policies.removePreset` via a subprocess
// and need to assert on the `session.policyPresets` mirror written by
// `syncSessionPolicyPresetsWithRegistry` (src/lib/actions/sandbox/policy-channel.ts).
//
// Two callers today:
//   - test/channels-mutates-presets.test.ts   (channels add/remove)
//   - test/policy-mutates-presets.test.ts     (policy-add/policy-remove)
//
// Each test file injects its own CLI-surface-specific module stubs
// (resolver/gateway/credentials for channels; loadPresetFromFile etc.
// for policy) and composes them with the shared sources below into
// the preamble that runs inside the subprocess.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execTimeout } from "./timeouts";

export const repoRoot = path.join(import.meta.dirname, "..", "..");

/**
 * Build a `require(...)` path string into the compiled dist tree, suitable
 * for inlining into a preamble template literal.
 */
export function distPath(relative: string): string {
  return JSON.stringify(path.join(repoRoot, "dist", "lib", relative));
}

/**
 * Spawn a Node subprocess running the given JS source. Mirrors the shape
 * both existing test files relied on, with a configurable extra env
 * (channels needs SLACK_* / TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN; policy
 * needs nothing extra).
 *
 * Timeout honours `NEMOCLAW_EXEC_TIMEOUT` (via `execTimeout`) so slow CI
 * environments can raise the ceiling without editing the test.
 */
export function runPresetSyncScript(
  scriptBody: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preset-sync-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  try {
    return spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: "1",
        ...extraEnv,
      },
      timeout: execTimeout(15_000),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * JS source that stubs `policies.*` and records every mutation in two
 * shapes:
 *   - `calls = { apply, applyContent, remove }` — grouped by API for
 *     direct assertions ("did applyPreset get called with X?")
 *   - `callOrder = ["applyPreset:X", "removePreset:Y", ...]` — preserves
 *     relative order, used by the #3437 ordering invariant (channels file)
 *     to assert apply MUST precede rebuild
 *
 * Defaults are chosen so most tests omit the option block entirely.
 */
export function policiesStubSource(opts: {
  /** Preset names returned by `policies.listPresets()`. */
  presetNames?: string[];
  /** Preset names returned by `policies.getAppliedPresets()`. */
  appliedPresets?: string[];
  /** Return value of `policies.applyPreset()`. Set to `false` to simulate failure. */
  applyResult?: boolean;
  /** Fake preset name returned by stubbed `loadPresetFromFile` (custom YAML path). */
  customPresetName?: string;
} = {}): string {
  const presetNames = opts.presetNames ?? ["telegram", "slack", "discord", "npm", "github", "pypi"];
  const appliedPresets = opts.appliedPresets ?? [];
  const applyResult = opts.applyResult ?? true;
  const customPresetName = opts.customPresetName ?? "custom-preset-from-file";

  return String.raw`
const policies = require(${distPath("policy/index.js")});
const calls = { apply: [], applyContent: [], remove: [] };
const callOrder = [];
policies.listPresets = () => ${JSON.stringify(presetNames.map((name) => ({ name })))};
policies.getAppliedPresets = () => ${JSON.stringify(appliedPresets)};
policies.loadPreset = (name) => ({ name, network_policies: {} });
policies.getPresetEndpoints = () => [];
policies.getMessagingPresetWarning = () => null;
policies.selectFromList = async (items) => (items[0] && items[0].name) || null;
policies.loadPresetFromFile = () => ({
  presetName: ${JSON.stringify(customPresetName)},
  content: { network_policies: {} },
});
policies.applyPreset = (sandboxName, presetName) => {
  calls.apply.push({ sandboxName, presetName });
  callOrder.push("applyPreset:" + presetName);
  return ${JSON.stringify(applyResult)};
};
policies.applyPresetContent = (sandboxName, presetName) => {
  calls.applyContent.push({ sandboxName, presetName });
  callOrder.push("applyPresetContent:" + presetName);
  return true;
};
policies.removePreset = (sandboxName, presetName) => {
  calls.remove.push({ sandboxName, presetName });
  callOrder.push("removePreset:" + presetName);
  return true;
};
`;
}

/**
 * JS source that stubs `onboardSession.loadSession` and `updateSession`,
 * exposing the seeded session state, a `sessionUpdates` log of every
 * mutator result, and a `getSessionState` getter for assertions on the
 * final state.
 *
 * All "failure injection" knobs default to false so happy-path tests
 * can omit them.
 */
export function sessionStubSource(opts: {
  /** Value of `session.sandboxName` (mismatch with the sandbox under test
   *  exercises the foreign-sandbox short-circuit). */
  sandboxName?: string | null;
  /** Initial `session.policyPresets` array. */
  policyPresets?: string[] | null;
  /** When true, `loadSession()` returns null (no session on disk). */
  missing?: boolean;
  /** When true, `loadSession()` throws to simulate read I/O failure. */
  loadThrows?: boolean;
  /** When true, `updateSession()` throws to simulate write I/O failure. */
  updateThrows?: boolean;
} = {}): string {
  const sandboxName = opts.sandboxName ?? "test-sb";
  const policyPresets = opts.policyPresets ?? null;
  const missing = opts.missing ?? false;
  const loadThrows = opts.loadThrows ?? false;
  const updateThrows = opts.updateThrows ?? false;

  return String.raw`
const onboardSession = require(${distPath("state/onboard-session.js")});
const sessionUpdates = [];
let sessionState = ${
    missing
      ? "null"
      : `{
  sandboxName: ${JSON.stringify(sandboxName)},
  policyPresets: ${JSON.stringify(policyPresets)},
}`
  };
onboardSession.loadSession = () => {
  if (${JSON.stringify(loadThrows)}) throw new Error("simulated load failure");
  return sessionState;
};
onboardSession.updateSession = (mutator) => {
  if (${JSON.stringify(updateThrows)}) throw new Error("simulated save failure");
  if (!sessionState) sessionState = { sandboxName: null, policyPresets: null };
  const next = mutator(sessionState) || sessionState;
  sessionState = next;
  sessionUpdates.push({
    policyPresets: Array.isArray(next.policyPresets) ? [...next.policyPresets] : next.policyPresets,
  });
  return next;
};
function getSessionState() { return sessionState; }
`;
}

/**
 * Marker convention used by every subprocess to communicate test results
 * back to the parent. Each test writes `__RESULT__` + JSON + newline to
 * stdout, and the parent parses the slice after the last marker so
 * incidental console output before it is harmless.
 */
export const RESULT_MARKER = "__RESULT__";

/**
 * Extract and parse the JSON payload emitted after the last RESULT_MARKER
 * in subprocess stdout. Throws if no marker is found.
 */
export function parseScriptResult<T = unknown>(stdout: string): T {
  const marker = stdout.lastIndexOf(RESULT_MARKER);
  if (marker < 0) {
    throw new Error(`no ${RESULT_MARKER} marker in stdout:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(marker + RESULT_MARKER.length).trim());
}
