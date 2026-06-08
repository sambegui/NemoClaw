// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createBuiltInChannelManifestRegistry, MessagingWorkflowPlanner } from "../../messaging";
import { resolveChannelProviderNamesForRemove } from "./channel-remove-provider-names";

async function buildTelegramPlan() {
  return new MessagingWorkflowPlanner(createBuiltInChannelManifestRegistry()).buildPlan({
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: ["telegram"],
    credentialAvailability: {
      TELEGRAM_BOT_TOKEN: true,
    },
  });
}

describe("resolveChannelProviderNamesForRemove", () => {
  it("returns provider names from a validated stored plan", async () => {
    const plan = await buildTelegramPlan();

    const result = resolveChannelProviderNamesForRemove({
      sandboxName: "demo",
      entry: {
        name: "demo",
        agent: "openclaw",
        messagingChannels: ["telegram"],
        disabledChannels: [],
        messaging: { schemaVersion: 1, plan },
      },
      channelId: "telegram",
      agent: { name: "openclaw" },
    });

    expect(result).toEqual({
      ok: true,
      providerNames: ["demo-telegram-bridge"],
    });
  });

  it("rejects stored plan provider-name tampering before exposing provider names", async () => {
    const plan = await buildTelegramPlan();
    const tampered = {
      ...plan,
      credentialBindings: plan.credentialBindings.map((binding) => ({
        ...binding,
        providerName: "other-sandbox-telegram-bridge",
      })),
    };

    const result = resolveChannelProviderNamesForRemove({
      sandboxName: "demo",
      entry: {
        name: "demo",
        agent: "openclaw",
        messagingChannels: ["telegram"],
        disabledChannels: [],
        messaging: { schemaVersion: 1, plan: tampered },
      },
      channelId: "telegram",
      agent: { name: "openclaw" },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/providerName/);
  });

  it("derives deterministic provider names for legacy pre-plan registry rows", () => {
    const result = resolveChannelProviderNamesForRemove({
      sandboxName: "demo",
      entry: {
        name: "demo",
        agent: "openclaw",
        messagingChannels: ["slack"],
      },
      channelId: "slack",
      agent: { name: "openclaw" },
    });

    expect(result).toEqual({
      ok: true,
      providerNames: ["demo-slack-bridge", "demo-slack-app"],
    });
  });
});
