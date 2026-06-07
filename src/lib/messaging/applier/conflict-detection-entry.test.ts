// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../manifest";
import type { SandboxMessagingState } from "../../state/registry";
import {
  conflictReasonForPair,
  conflictReasonForRequest,
  detectAllOverlapsInEntries,
  findConflictsInEntries,
  hasStoredChannelInEntry,
  type ConflictRegistryEntry,
} from "./conflict-detection";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlan(
  sandboxName: string,
  overrides: Partial<SandboxMessagingPlan> = {},
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

function tgChannel(active = true, disabled = false) {
  return {
    channelId: "telegram" as const,
    displayName: "Telegram",
    authMode: "token-paste" as const,
    active,
    selected: true,
    configured: true,
    disabled,
    inputs: [],
    hooks: [],
  };
}

function slackChannel() {
  return {
    channelId: "slack" as const,
    displayName: "Slack",
    authMode: "token-paste" as const,
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

function tgBinding(hash?: string): SandboxMessagingPlan["credentialBindings"][number] {
  return {
    channelId: "telegram",
    credentialId: "telegramBotToken",
    sourceInput: "botToken",
    providerName: "sb-telegram-bridge",
    providerEnvKey: "TELEGRAM_BOT_TOKEN",
    placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    credentialAvailable: true,
    ...(hash !== undefined ? { credentialHash: hash } : {}),
  };
}

function slackBindings(botHash?: string, appHash?: string) {
  return [
    {
      channelId: "slack" as const,
      credentialId: "slackBotToken",
      sourceInput: "botToken",
      providerName: "sb-slack-bridge",
      providerEnvKey: "SLACK_BOT_TOKEN",
      placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
      credentialAvailable: true,
      ...(botHash ? { credentialHash: botHash } : {}),
    },
    {
      channelId: "slack" as const,
      credentialId: "slackAppToken",
      sourceInput: "appToken",
      providerName: "sb-slack-app",
      providerEnvKey: "SLACK_APP_TOKEN",
      placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
      credentialAvailable: true,
      ...(appHash ? { credentialHash: appHash } : {}),
    },
  ];
}

function planEntry(name: string, plan: SandboxMessagingPlan): ConflictRegistryEntry {
  const state: SandboxMessagingState = { schemaVersion: 1, plan };
  return { name, messaging: state };
}

// ---------------------------------------------------------------------------
// hasStoredChannelInEntry
// ---------------------------------------------------------------------------

describe("hasStoredChannelInEntry", () => {
  it("returns true for an active channel in a plan-backed entry", () => {
    const entry = planEntry("sb", makePlan("sb", { channels: [tgChannel()] }));
    expect(hasStoredChannelInEntry(entry, "telegram")).toBe(true);
  });

  it("returns false when channel is in plan.disabledChannels", () => {
    const entry = planEntry(
      "sb",
      makePlan("sb", { disabledChannels: ["telegram"], channels: [tgChannel(true, true)] }),
    );
    expect(hasStoredChannelInEntry(entry, "telegram")).toBe(false);
  });

  it("returns false when channel.active is false", () => {
    const entry = planEntry("sb", makePlan("sb", { channels: [tgChannel(false, false)] }));
    expect(hasStoredChannelInEntry(entry, "telegram")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// conflictReasonForRequest
// ---------------------------------------------------------------------------

describe("conflictReasonForRequest", () => {
  it("detects matching-token when same channel hash matches", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBe("matching-token");
  });

  it("returns null when same channel hash differs", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-b" },
      }),
    ).toBeNull();
  });

  it("does not produce false positives from unrelated-channel hashes", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-a"), ...slackBindings("hash-slack")],
      }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg-b" },
      }),
    ).toBeNull();
  });

  it("returns unknown-token when plan has no hashes for the channel", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding()] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBe("unknown-token");
  });
});

// ---------------------------------------------------------------------------
// conflictReasonForPair
// ---------------------------------------------------------------------------

describe("conflictReasonForPair", () => {
  it("detects matching-token between two plan-backed entries", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBe("matching-token");
  });

  it("returns null when same-channel hashes differ", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-b")] }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBeNull();
  });

  it("scopes comparison to the requested channel, ignoring other channels", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-a"), ...slackBindings("hash-slack")],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-b"), ...slackBindings("hash-slack")],
      }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBeNull();
    expect(conflictReasonForPair("slack", alice, bob)).toBe("matching-token");
  });
});

// ---------------------------------------------------------------------------
// findConflictsInEntries
// ---------------------------------------------------------------------------

describe("findConflictsInEntries", () => {
  it("detects matching-token against a plan-only entry", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        [alice],
      ),
    ).toEqual([{ channel: "telegram", sandbox: "alice", reason: "matching-token" }]);
  });

  it("ignores a disabled channel in a plan-backed entry", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        disabledChannels: ["telegram"],
        channels: [tgChannel(true, true)],
        credentialBindings: [tgBinding("hash-a")],
      }),
    );
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        [alice],
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectAllOverlapsInEntries
// ---------------------------------------------------------------------------

describe("detectAllOverlapsInEntries", () => {
  it("reports matching-token overlap between two plan-backed entries", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(detectAllOverlapsInEntries([alice, bob])).toEqual([
      { channel: "telegram", sandboxes: ["alice", "bob"], reason: "matching-token" },
    ]);
  });

  it("does not report overlap when shared channel is disabled in one plan", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        disabledChannels: ["telegram"],
        channels: [tgChannel(true, true)],
        credentialBindings: [tgBinding("hash-a")],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(detectAllOverlapsInEntries([alice, bob])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multi-credential channel partial-hash suppression (Slack SLACK_BOT_TOKEN +
// SLACK_APP_TOKEN). Both manifest keys are required; a differing bot token
// with a missing app token must NOT return null — it must return unknown-token.
// ---------------------------------------------------------------------------

describe("multi-credential channel partial hash suppression", () => {
  it("conflictReasonForRequest — returns unknown-token when Slack bot tokens differ but app token is missing from stored plan", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [
          {
            channelId: "slack",
            credentialId: "slackBotToken",
            sourceInput: "botToken",
            providerName: "alice-slack-bridge",
            providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true,
            credentialHash: "hash-bot-a",
          },
          // No SLACK_APP_TOKEN binding
        ],
      }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "slack",
        credentialHashes: { SLACK_BOT_TOKEN: "hash-bot-b", SLACK_APP_TOKEN: "hash-app-x" },
      }),
    ).toBe("unknown-token"); // bot tokens differ but app token unknown → conservative
  });

  it("conflictReasonForRequest — returns null when both Slack tokens are present and both differ", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [
          {
            channelId: "slack",
            credentialId: "slackBotToken",
            sourceInput: "botToken",
            providerName: "alice-slack-bridge",
            providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true,
            credentialHash: "hash-bot-a",
          },
          {
            channelId: "slack",
            credentialId: "slackAppToken",
            sourceInput: "appToken",
            providerName: "alice-slack-app",
            providerEnvKey: "SLACK_APP_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
            credentialAvailable: true,
            credentialHash: "hash-app-a",
          },
        ],
      }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "slack",
        credentialHashes: { SLACK_BOT_TOKEN: "hash-bot-b", SLACK_APP_TOKEN: "hash-app-b" },
      }),
    ).toBeNull();
  });

  it("conflictReasonForPair — returns unknown-token when Slack bot tokens differ but app token is absent from both plans", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [
          {
            channelId: "slack",
            credentialId: "slackBotToken",
            sourceInput: "botToken",
            providerName: "alice-slack-bridge",
            providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true,
            credentialHash: "hash-bot-a",
          },
        ],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [slackChannel()],
        credentialBindings: [
          {
            channelId: "slack",
            credentialId: "slackBotToken",
            sourceInput: "botToken",
            providerName: "bob-slack-bridge",
            providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true,
            credentialHash: "hash-bot-b",
          },
        ],
      }),
    );
    expect(conflictReasonForPair("slack", alice, bob)).toBe("unknown-token");
  });

  it("conflictReasonForPair — returns null when both Slack tokens are present and both differ", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [
          {
            channelId: "slack", credentialId: "slackBotToken", sourceInput: "botToken",
            providerName: "alice-slack-bridge", providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true, credentialHash: "hash-bot-a",
          },
          {
            channelId: "slack", credentialId: "slackAppToken", sourceInput: "appToken",
            providerName: "alice-slack-app", providerEnvKey: "SLACK_APP_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
            credentialAvailable: true, credentialHash: "hash-app-a",
          },
        ],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [slackChannel()],
        credentialBindings: [
          {
            channelId: "slack", credentialId: "slackBotToken", sourceInput: "botToken",
            providerName: "bob-slack-bridge", providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true, credentialHash: "hash-bot-b",
          },
          {
            channelId: "slack", credentialId: "slackAppToken", sourceInput: "appToken",
            providerName: "bob-slack-app", providerEnvKey: "SLACK_APP_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
            credentialAvailable: true, credentialHash: "hash-app-b",
          },
        ],
      }),
    );
    expect(conflictReasonForPair("slack", alice, bob)).toBeNull();
  });
});
