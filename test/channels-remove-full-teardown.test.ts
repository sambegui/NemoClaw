// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #3998 — `nemoclaw <sandbox> channels remove <channel>`
// must (1) strip the channel from session.policyPresets so onboard --resume
// does not re-apply the preset on rebuild, and (2) wipe the channel's
// durable state inside the sandbox so the rebuild's state_dirs backup
// does not restore stale auth files that would let the channel
// auto-reconnect after the operator asked NemoClaw to forget it.

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string, extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-3998-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
      ...extraEnv,
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

function buildPreamble({
  presetNamesApplied = ["npm", "pypi", "huggingface", "brew", "whatsapp"],
  sandboxAgent = "openclaw",
}: {
  presetNamesApplied?: string[];
  sandboxAgent?: string;
} = {}): string {
  const j = (p: string) => JSON.stringify(path.join(repoRoot, "dist", "lib", p));
  return String.raw`
const resolver = require(${j("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const runner = require(${j("runner.js")});
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = () => "";

const adapterRuntime = require(${j("adapters/openshell/runtime.js")});
adapterRuntime.runOpenshell = () => ({ status: 0, stdout: "", stderr: "" });

const processRecovery = require(${j("actions/sandbox/process-recovery.js")});
const sandboxExecCalls = [];
processRecovery.executeSandboxExecCommand = (sandboxName, command) => {
  sandboxExecCalls.push({ sandboxName, command });
  return { status: 0, stdout: "", stderr: "" };
};

const gatewayRuntime = require(${j("gateway-runtime-action.js")});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true });

const credentials = require(${j("credentials/store.js")});
credentials.getCredential = () => null;
credentials.saveCredential = () => true;
credentials.deleteCredential = () => true;
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };

const onboard = require(${j("onboard.js")});
onboard.isNonInteractive = () => true;

const onboardSession = require(${j("state/onboard-session.js")});
const sessionStore = {
  sandboxName: "test-sb",
  policyPresets: ${JSON.stringify(presetNamesApplied)},
  resumable: false,
  status: "complete",
  agent: ${JSON.stringify(sandboxAgent)},
  provider: null,
  model: null,
  endpointUrl: null,
  credentialEnv: null,
  hermesAuthMethod: null,
  preferredInferenceApi: null,
  nimContainer: null,
  routerPid: null,
  routerCredentialHash: null,
  policyTier: null,
  messagingChannels: ["whatsapp"],
  messagingChannelConfig: null,
  disabledChannels: [],
  hermesToolGateways: [],
  wechatConfig: null,
};
const sessionUpdates = [];
onboardSession.loadSession = () => sessionStore;
onboardSession.updateSession = (mutate) => {
  const before = { policyPresets: [...(sessionStore.policyPresets || [])] };
  mutate(sessionStore);
  sessionUpdates.push({ before, after: { policyPresets: [...(sessionStore.policyPresets || [])] } });
};

const registry = require(${j("state/registry.js")});
registry.getSandbox = () => ({
  name: "test-sb",
  agent: ${JSON.stringify(sandboxAgent)},
  messagingChannels: ["whatsapp"],
  disabledChannels: [],
  providerCredentialHashes: {},
  policies: ${JSON.stringify(presetNamesApplied)},
});
registry.updateSandbox = () => true;

const policies = require(${j("policy/index.js")});
const removedPresets = [];
policies.listPresets = () => ${JSON.stringify(presetNamesApplied.map((name) => ({ name })))};
policies.getAppliedPresets = () => ${JSON.stringify(presetNamesApplied)};
policies.removePreset = (sandboxName, presetName) => {
  removedPresets.push({ sandboxName, presetName });
  return true;
};

const callOrder = [];
const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (line.includes("Change queued")) callOrder.push("promptAndRebuild");
  if (line.includes("Cleared in-sandbox")) callOrder.push("clearedSandboxState");
  origLog.call(console, ...args);
};

const channelModule = require(${j("actions/sandbox/policy-channel.js")});

module.exports = {
  channelModule,
  sandboxExecCalls,
  sessionUpdates,
  removedPresets,
  sessionStore,
  callOrder,
};
`;
}

describe("channels remove full teardown (issue #3998)", () => {
  for (const sandboxAgent of ["openclaw", "hermes"] as const) {
    it(`strips '${sandboxAgent}' session.policyPresets and clears the in-sandbox whatsapp state dir`, () => {
      const script = `${buildPreamble({ sandboxAgent })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sandboxExecCalls: ctx.sandboxExecCalls,
      sessionPolicyPresets: ctx.sessionStore.policyPresets,
      removedPresets: ctx.removedPresets,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
      const result = runScript(script);
      assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
      const marker = result.stdout.lastIndexOf("__RESULT__");
      assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
      const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
      assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

      assert.deepEqual(
        payload.removedPresets,
        [{ sandboxName: "test-sb", presetName: "whatsapp" }],
        `expected one removePreset('whatsapp') call; got ${JSON.stringify(payload.removedPresets)}`,
      );

      assert.ok(
        !payload.sessionPolicyPresets.includes("whatsapp"),
        `session.policyPresets must not contain 'whatsapp' after remove (resume would reapply it). Got: ${JSON.stringify(payload.sessionPolicyPresets)}`,
      );
      assert.deepEqual(
        payload.sessionPolicyPresets,
        ["npm", "pypi", "huggingface", "brew"],
        "non-channel presets must stay in session.policyPresets",
      );

      const cleanupCalls = payload.sandboxExecCalls.filter((c: { command: string }) =>
        c.command.startsWith("rm -rf"),
      );
      assert.equal(
        cleanupCalls.length,
        1,
        `expected one rm -rf sandbox-exec call; got ${cleanupCalls.length}`,
      );
      const expectedPath =
        sandboxAgent === "openclaw"
          ? "/sandbox/.openclaw/whatsapp"
          : "/sandbox/.hermes/platforms/whatsapp";
      assert.ok(
        cleanupCalls[0].command.includes(expectedPath),
        `expected cleanup to target '${expectedPath}'; got ${cleanupCalls[0].command}`,
      );

      const rebuildIdx = payload.callOrder.indexOf("promptAndRebuild");
      const clearIdx = payload.callOrder.indexOf("clearedSandboxState");
      assert.ok(rebuildIdx >= 0, `promptAndRebuild was never called: ${JSON.stringify(payload.callOrder)}`);
      assert.ok(clearIdx >= 0, `clearedSandboxState marker was never logged: ${JSON.stringify(payload.callOrder)}`);
      assert.ok(
        clearIdx < rebuildIdx,
        `sandbox state must be cleared before rebuild so the backup excludes the auth files: ${JSON.stringify(payload.callOrder)}`,
      );
    });
  }

  it("leaves non-whatsapp presets in session.policyPresets untouched when removing a token-based channel", () => {
    const script = `${buildPreamble({
      presetNamesApplied: ["npm", "pypi", "telegram", "brew"],
      sandboxAgent: "openclaw",
    })}
const ctx = module.exports;
const registryOverride = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "state/registry.js"))});
registryOverride.getSandbox = () => ({
  name: "test-sb",
  agent: "openclaw",
  messagingChannels: ["telegram"],
  disabledChannels: [],
  providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash" },
  policies: ["npm", "pypi", "telegram", "brew"],
});
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "telegram" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionPolicyPresets: ctx.sessionStore.policyPresets,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script, { TELEGRAM_BOT_TOKEN: "stub" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.ok(
      !payload.sessionPolicyPresets.includes("telegram"),
      `session.policyPresets must drop 'telegram' after channel remove. Got: ${JSON.stringify(payload.sessionPolicyPresets)}`,
    );
    assert.deepEqual(
      payload.sessionPolicyPresets,
      ["npm", "pypi", "brew"],
      "other presets must remain after removing a token-based channel",
    );
  });
});
