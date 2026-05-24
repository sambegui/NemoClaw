// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for two related invariants on `nemoclaw <sandbox> channels add/remove`:
//
//   1. Issue #3437 (ordering): `channels add` MUST apply the channel's
//      matching network policy preset BEFORE triggering the rebuild, so
//      the rebuild's backup manifest captures the preset and the bridge
//      has egress to its upstream API after the new sandbox boots.
//
//   2. #3437 follow-up (session sync): `channels add`/`channels remove`
//      MUST mirror the registry-side preset mutation into
//      `session.policyPresets` via `syncSessionPolicyPresetsWithRegistry`.
//      Otherwise a later `rebuild` re-enters onboard resume, reads the
//      stale session, and narrows the channel preset back away — the
//      original bug that motivated the helper.
//
// Both invariants share the same subprocess-stub scaffolding from
// test/helpers/preset-sync-mocks.ts. The channels-specific module stubs
// (resolver, gateway runtime, credentials, onboard providers, registry)
// stay inline here since they are not needed by the parallel test file
// test/policy-add-remove-session-sync.test.ts.

import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { describe, it } from "vitest";

import {
  distPath,
  parseScriptResult,
  policiesStubSource,
  runPresetSyncScript,
  sessionStubSource,
} from "./helpers/preset-sync-mocks";

/**
 * `runPresetSyncScript` with channels-specific default tokens injected.
 * Every channel covered by these tests reads at least one of these tokens
 * during `acquirePasteTokens`; defaulting them avoids polluting every
 * `it()` block with token boilerplate.
 */
function runChannelsScript(
  scriptBody: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return runPresetSyncScript(scriptBody, {
    TELEGRAM_BOT_TOKEN: "test-telegram-token",
    SLACK_BOT_TOKEN: "xoxb-test-1234-5678",
    SLACK_APP_TOKEN: "xapp-1-test-1234-5678",
    DISCORD_BOT_TOKEN: "test-discord-token",
    ...extraEnv,
  });
}

/**
 * Build a preamble that:
 *   - stubs every module touched by `addSandboxChannel` so no real
 *     openshell / gateway / credential write happens
 *   - composes the shared `policiesStubSource` (records `calls.apply` /
 *     `calls.applyContent` / `calls.remove` and a sequential `callOrder`)
 *   - composes the shared `sessionStubSource` (records `sessionUpdates`
 *     and exposes `getSessionState()`)
 *   - extends `callOrder` with a `"promptAndRebuild"` marker via a
 *     console.log hook so #3437 ordering assertions can compare the
 *     preset apply against the rebuild prompt relative position
 */
function buildPreamble(opts: {
  presetNames?: string[];
  applyResult?: boolean;
  sandboxAgent?: string;
  sessionSandboxName?: string | null;
  sessionPolicyPresets?: string[] | null;
  sessionMissing?: boolean;
  sessionLoadThrows?: boolean;
  sessionUpdateThrows?: boolean;
} = {}): string {
  const sandboxAgent = opts.sandboxAgent ?? "openclaw";
  return String.raw`
const resolver = require(${distPath("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const runner = require(${distPath("runner.js")});
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = () => "";

const gatewayRuntime = require(${distPath("gateway-runtime-action.js")});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true });

const credentials = require(${distPath("credentials/store.js")});
credentials.getCredential = (key) => process.env[key] || null;
credentials.saveCredential = () => true;
credentials.deleteCredential = () => true;
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };

const onboard = require(${distPath("onboard.js")});
onboard.isNonInteractive = () => true;

const onboardProviders = require(${distPath("onboard/providers.js")});
const providerCalls = [];
onboardProviders.upsertMessagingProviders = (defs) => { providerCalls.push(...defs); };

const registry = require(${distPath("state/registry.js")});
const registryUpdates = [];
registry.getSandbox = () => ({
  name: "test-sb",
  agent: ${JSON.stringify(sandboxAgent)},
  messagingChannels: [],
  disabledChannels: [],
  providerCredentialHashes: {},
});
registry.updateSandbox = (name, updates) => {
  registryUpdates.push({ name, updates });
  return true;
};

${policiesStubSource({
  presetNames: opts.presetNames ?? ["telegram", "slack", "discord", "npm", "github"],
  applyResult: opts.applyResult,
})}

${sessionStubSource({
  sandboxName: opts.sessionSandboxName,
  policyPresets: opts.sessionPolicyPresets,
  missing: opts.sessionMissing,
  loadThrows: opts.sessionLoadThrows,
  updateThrows: opts.sessionUpdateThrows,
})}

// Channels-specific: tag the rebuild-prompt branch via stdout so #3437
// ordering tests can assert applyPreset PRECEDES promptAndRebuild. In
// NEMOCLAW_NON_INTERACTIVE mode promptAndRebuild logs "Change queued."
// and returns immediately without invoking rebuildSandbox.
const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (line.includes("Change queued")) callOrder.push("promptAndRebuild");
  origLog.call(console, ...args);
};

const channelModule = require(${distPath("actions/sandbox/policy-channel.js")});

module.exports = {
  channelModule,
  calls,
  callOrder,
  providerCalls,
  registryUpdates,
  sessionUpdates,
  getSessionState,
};
`;
}

describe("channels add applies matching policy preset (issue #3437)", () => {
  for (const channel of ["telegram", "slack", "discord"]) {
    it(`applies the '${channel}' preset before triggering rebuild`, () => {
      const script = `${buildPreamble()}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: ${JSON.stringify(channel)} });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
      const result = runChannelsScript(script);
      assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
      const payload = parseScriptResult<{
        calls: { apply: { sandboxName: string; presetName: string }[] };
        callOrder: string[];
        error?: string;
        stack?: string;
      }>(result.stdout);
      assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

      // Contract 1: applyPreset is called exactly once with the channel's name.
      assert.deepEqual(
        payload.calls.apply,
        [{ sandboxName: "test-sb", presetName: channel }],
        `expected applyPreset("test-sb", "${channel}") exactly once; got ${JSON.stringify(payload.calls.apply)}`,
      );

      // Contract 2: ordering invariant — preset apply must precede rebuild,
      // otherwise the rebuild's backup manifest will not capture it and
      // Step 5.5 of rebuild.ts has nothing to restore.
      const applyIdx = payload.callOrder.indexOf(`applyPreset:${channel}`);
      const rebuildIdx = payload.callOrder.indexOf("promptAndRebuild");
      assert.ok(applyIdx >= 0, `applyPreset was never called (order: ${JSON.stringify(payload.callOrder)})`);
      assert.ok(rebuildIdx >= 0, `promptAndRebuild was never called (order: ${JSON.stringify(payload.callOrder)})`);
      assert.ok(
        applyIdx < rebuildIdx,
        `applyPreset must run before promptAndRebuild; got order: ${JSON.stringify(payload.callOrder)}`,
      );
    });
  }

  it("applies the tokenless WhatsApp preset for Hermes before triggering rebuild", () => {
    const script = `${buildPreamble({
      presetNames: ["telegram", "slack", "discord", "whatsapp", "npm", "github"],
      sandboxAgent: "hermes",
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      callOrder: ctx.callOrder,
      providerCalls: ctx.providerCalls,
      registryUpdates: ctx.registryUpdates,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runChannelsScript(script, {
      WHATSAPP_BOT_TOKEN: "must-not-be-used",
      WHATSAPP_TOKEN: "must-not-be-used",
      WHATSAPP_SESSION_SECRET: "must-not-be-used",
    });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { apply: { sandboxName: string; presetName: string }[] };
      callOrder: string[];
      providerCalls: unknown[];
      registryUpdates: { name: string; updates: Record<string, unknown> }[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.providerCalls, [], "WhatsApp must not create host-side providers");
    assert.deepEqual(payload.registryUpdates, [
      {
        name: "test-sb",
        updates: { messagingChannels: ["whatsapp"], disabledChannels: [] },
      },
    ]);
    assert.deepEqual(
      payload.calls.apply,
      [{ sandboxName: "test-sb", presetName: "whatsapp" }],
      `expected applyPreset("test-sb", "whatsapp") exactly once; got ${JSON.stringify(payload.calls.apply)}`,
    );
    const applyIdx = payload.callOrder.indexOf("applyPreset:whatsapp");
    const rebuildIdx = payload.callOrder.indexOf("promptAndRebuild");
    assert.ok(applyIdx >= 0, `applyPreset was never called (order: ${JSON.stringify(payload.callOrder)})`);
    assert.ok(rebuildIdx >= 0, `promptAndRebuild was never called (order: ${JSON.stringify(payload.callOrder)})`);
    assert.ok(
      applyIdx < rebuildIdx,
      `applyPreset must run before promptAndRebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("aborts tokenless WhatsApp before registry and rebuild when preset apply fails", () => {
    const script = `${buildPreamble({
      presetNames: ["telegram", "slack", "discord", "whatsapp", "npm", "github"],
      applyResult: false,
      sandboxAgent: "hermes",
    })}
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "whatsapp" });
  } catch (err) {
    if (!String(err && err.message).startsWith("__EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
      return;
    }
  } finally {
    process.exit = originalExit;
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    calls: ctx.calls,
    callOrder: ctx.callOrder,
    providerCalls: ctx.providerCalls,
    registryUpdates: ctx.registryUpdates,
    exitCodes,
  }) + "\\n");
})();
`;
    const result = runChannelsScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { apply: { sandboxName: string; presetName: string }[] };
      callOrder: string[];
      providerCalls: unknown[];
      registryUpdates: unknown[];
      exitCodes: number[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.providerCalls, [], "WhatsApp must not create host-side providers");
    assert.deepEqual(
      payload.registryUpdates,
      [],
      `preset failure must not register whatsapp locally; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.deepEqual(
      payload.calls.apply,
      [{ sandboxName: "test-sb", presetName: "whatsapp" }],
      `expected one failed applyPreset call; got ${JSON.stringify(payload.calls.apply)}`,
    );
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `preset failure must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });

  // Negative: when the channel name does not match any built-in preset,
  // the helper short-circuits via listPresets() and applyPreset is not
  // invoked at all. This guards against a future channel name that happens
  // to collide with no preset (or a typo) from spamming "Cannot load preset"
  // errors out of policies.applyPreset.
  it("skips applyPreset when no matching built-in preset exists", () => {
    const script = `${buildPreamble({ presetNames: ["npm", "github"] })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runChannelsScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { apply: unknown[] };
      callOrder: string[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(
      payload.calls.apply,
      [],
      `expected applyPreset NOT to be called when no built-in preset matches; got ${JSON.stringify(payload.calls.apply)}`,
    );
    // Rebuild should still be triggered — channel registration succeeded,
    // only the preset path was skipped.
    assert.ok(
      payload.callOrder.includes("promptAndRebuild"),
      `expected promptAndRebuild to still run; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });
});

// Regression: `channels add` was updating the registry but NOT
// session.policyPresets. A later `rebuild` re-entered onboard in resume
// mode, read the stale session, and the policy-selection step narrowed
// the channel's preset back away. The new sandbox booted with the
// channel auto-launched but no matching network policy active, so the
// bridge's Slack/Telegram/Discord WebClient hit 403s and stayed wedged
// even after Step 5.5 of rebuild reapplied the preset from the backup
// manifest.
//
// These tests pin down the invariant: after a successful preset apply
// via channels-add, session.policyPresets must contain the channel
// name; after a successful preset remove via channels-remove, it must
// not. Edge cases (no session, foreign sandbox, save failure) must not
// abort the operation.
describe("channels add/remove keeps session.policyPresets in sync with registry", () => {
  it("appends the channel preset to session.policyPresets after a successful add", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "pypi", "huggingface", "brew"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runChannelsScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      sessionUpdates: { policyPresets: string[] | null }[];
      finalSession: { policyPresets: string[] | null };
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Exactly one update — the helper short-circuits when the desired
    // membership already holds, so duplicate writes would be a bug.
    assert.equal(
      payload.sessionUpdates.length,
      1,
      `expected exactly one session update; got ${JSON.stringify(payload.sessionUpdates)}`,
    );
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, [
      "npm",
      "pypi",
      "huggingface",
      "brew",
      "slack",
    ]);
    assert.deepEqual(payload.finalSession.policyPresets, [
      "npm",
      "pypi",
      "huggingface",
      "brew",
      "slack",
    ]);
  });

  it("does not touch the session when it tracks a different sandbox", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "other-sb",
      sessionPolicyPresets: ["npm", "github"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
      calls: ctx.calls,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runChannelsScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      sessionUpdates: { policyPresets: string[] | null }[];
      finalSession: { policyPresets: string[] | null };
      calls: { apply: { sandboxName: string; presetName: string }[] };
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // applyPreset still runs against the registry — the preset is the
    // channel's egress contract and lives in registry, not session.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "slack" }]);
    // But the foreign session's policyPresets must be left untouched —
    // otherwise we corrupt the other sandbox's resume state.
    assert.deepEqual(
      payload.sessionUpdates,
      [],
      `session belonging to a different sandbox must not be mutated; got ${JSON.stringify(payload.sessionUpdates)}`,
    );
    assert.deepEqual(payload.finalSession.policyPresets, ["npm", "github"]);
  });

  it("succeeds even when no onboard session file exists", () => {
    const script = `${buildPreamble({ sessionMissing: true })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionUpdates: ctx.sessionUpdates,
      calls: ctx.calls,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runChannelsScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      sessionUpdates: { policyPresets: string[] | null }[];
      calls: { apply: { sandboxName: string; presetName: string }[] };
      callOrder: string[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Registry mutation still happens; only the session-sync side-effect
    // is skipped (there is no intent record to keep aligned).
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.deepEqual(payload.sessionUpdates, []);
    assert.ok(payload.callOrder.includes("promptAndRebuild"));
  });

  it("does not abort channels-add when session save fails", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "pypi", "huggingface", "brew"],
      sessionUpdateThrows: true,
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runChannelsScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const payload = parseScriptResult<{
      calls: { apply: { sandboxName: string; presetName: string }[] };
      callOrder: string[];
      error?: string;
      stack?: string;
    }>(result.stdout);
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Even though session.updateSession threw, the channel add flow
    // still completed: preset applied to registry, rebuild prompted.
    // Session-sync is best-effort.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.ok(payload.callOrder.includes("promptAndRebuild"));
  });
});
