// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for the same session/registry divergence that motivated
// the channels-add fix (see test/channels-add-preset.test.ts). The bug
// surfaced first via `nemoclaw <sb> channels add slack` → `rebuild`
// (registry got slack, session did not, rebuild's resume step narrowed
// it back away). The exact same divergence applies to the standalone
// preset-mutation CLIs:
//
//   - `nemoclaw <sb> policy-add <preset>`       (built-in preset)
//   - `nemoclaw <sb> policy-add --from-file …`  (custom preset YAML)
//   - `nemoclaw <sb> policy-remove <preset>`    (any preset)
//
// All three call `policies.applyPreset` / `policies.applyPresetContent` /
// `policies.removePreset` to mutate the registry; none of them previously
// touched `session.policyPresets`. These tests pin down the invariant
// that after the channels-add fix was generalised, all three paths now
// keep session in sync with registry, with the same best-effort error
// handling.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  distPath,
  parseScriptResult,
  policiesStubSource,
  runPresetSyncScript,
  sessionStubSource,
} from "./helpers/preset-sync-mocks";

/**
 * Build a JS preamble that stubs every module touched by
 * `addSandboxPolicy` / `removeSandboxPolicy` so no real openshell,
 * gateway, or filesystem credential write happens. Composes the
 * shared `policiesStubSource` + `sessionStubSource` with the small
 * policy-specific module stubs (`onboard.isNonInteractive`,
 * `credentials.prompt`).
 */
function buildPreamble(opts: {
  presetNames?: string[];
  appliedPresets?: string[];
  applyResult?: boolean;
  sessionSandboxName?: string | null;
  sessionPolicyPresets?: string[] | null;
  sessionMissing?: boolean;
  sessionLoadThrows?: boolean;
  sessionUpdateThrows?: boolean;
} = {}): string {
  return String.raw`
const onboard = require(${distPath("onboard.js")});
onboard.isNonInteractive = () => true;

const credentials = require(${distPath("credentials/store.js")});
credentials.prompt = async () => "y";

${policiesStubSource({
  presetNames: opts.presetNames ?? ["github", "npm", "pypi"],
  appliedPresets: opts.appliedPresets,
  applyResult: opts.applyResult,
})}

${sessionStubSource({
  sandboxName: opts.sessionSandboxName,
  policyPresets: opts.sessionPolicyPresets ?? ["npm"],
  missing: opts.sessionMissing,
  loadThrows: opts.sessionLoadThrows,
  updateThrows: opts.sessionUpdateThrows,
})}

const channelModule = require(${distPath("actions/sandbox/policy-channel.js")});

module.exports = { channelModule, calls, callOrder, sessionUpdates, getSessionState };
`;
}

describe("policy-add / policy-remove keep session.policyPresets in sync with registry", () => {
  it("appends the built-in preset to session.policyPresets after policy-add", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runPresetSyncScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { apply: { sandboxName: string; presetName: string }[] };
      sessionUpdates: { policyPresets: string[] | null }[];
      finalSession: { policyPresets: string[] | null };
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Contract 1: applyPreset called exactly once with the chosen preset.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "github" }]);
    // Contract 2: session updated exactly once, github appended.
    assert.equal(payload.sessionUpdates.length, 1);
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, ["npm", "github"]);
    assert.deepEqual(payload.finalSession.policyPresets, ["npm", "github"]);
  });

  it("appends the custom preset (--from-file) to session.policyPresets", () => {
    // Write a tiny YAML file the stubbed loadPresetFromFile will pretend to parse.
    const presetDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preset-"));
    const yamlPath = path.join(presetDir, "custom.yaml");
    fs.writeFileSync(yamlPath, "name: custom-preset-from-file\nnetwork_policies: {}\n");

    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { fromFile: ${JSON.stringify(yamlPath)}, yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runPresetSyncScript(script);
    fs.rmSync(presetDir, { recursive: true, force: true });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { applyContent: { sandboxName: string; presetName: string }[] };
      sessionUpdates: { policyPresets: string[] | null }[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // The custom-preset path goes through applyPresetContent (NOT applyPreset).
    assert.deepEqual(payload.calls.applyContent, [
      { sandboxName: "test-sb", presetName: "custom-preset-from-file" },
    ]);
    assert.equal(payload.sessionUpdates.length, 1);
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, ["npm", "custom-preset-from-file"]);
  });

  it("removes the preset from session.policyPresets after policy-remove", () => {
    const script = `${buildPreamble({
      appliedPresets: ["npm", "github"],
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "github"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runPresetSyncScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { remove: { sandboxName: string; presetName: string }[] };
      sessionUpdates: { policyPresets: string[] | null }[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.calls.remove, [{ sandboxName: "test-sb", presetName: "github" }]);
    assert.equal(payload.sessionUpdates.length, 1);
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, ["npm"]);
  });

  it("does not touch a session belonging to a different sandbox", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "other-sb",
      sessionPolicyPresets: ["pypi"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runPresetSyncScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { apply: { sandboxName: string; presetName: string }[] };
      sessionUpdates: { policyPresets: string[] | null }[];
      finalSession: { policyPresets: string[] | null };
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Registry mutation still happens — that lives per-sandbox in the
    // OpenShell policy engine, not in the session file.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "github" }]);
    // But session for "other-sb" must be left alone.
    assert.deepEqual(payload.sessionUpdates, []);
    assert.deepEqual(payload.finalSession.policyPresets, ["pypi"]);
  });

  it("completes policy-add when no onboard session exists", () => {
    const script = `${buildPreamble({ sessionMissing: true })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runPresetSyncScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { apply: { sandboxName: string; presetName: string }[] };
      sessionUpdates: { policyPresets: string[] | null }[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Registry mutation succeeded; session-sync was a no-op (no session
    // to keep in sync). policy-add must NOT abort the operation in this case.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "github" }]);
    assert.deepEqual(payload.sessionUpdates, []);
  });
});
