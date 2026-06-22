// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingInputReference } from "../../manifest";
import { resolveMattermostTemplateReference } from "./template-resolver";

function input(inputId: string, statePath: string, value: string): SandboxMessagingInputReference {
  return {
    channelId: "mattermost",
    inputId,
    kind: "config",
    required: false,
    statePath,
    value,
  };
}

describe("Mattermost template resolver", () => {
  it("normalizes Mattermost base URLs for OpenClaw config", () => {
    const inputs = [
      input("baseUrl", "mattermostConfig.baseUrl", "https://chat.example.com/api/v4/"),
    ];

    expect(resolveMattermostTemplateReference("mattermostConfig.baseUrl", { inputs })?.value).toBe(
      "https://chat.example.com",
    );
  });

  it("maps mention, channel, and user allowlists into OpenClaw group policy", () => {
    const inputs: SandboxMessagingInputReference[] = [
      input("requireMention", "mattermostConfig.requireMention", "1"),
      input("allowedChannels", "mattermostConfig.allowedChannels", "town-square,ops"),
      input("allowedUsers", "allowedIds.mattermost", "user-a,user-b"),
    ];

    expect(
      resolveMattermostTemplateReference("mattermostConfig.openclawChatmode", { inputs })?.value,
    ).toBe("oncall");
    expect(
      resolveMattermostTemplateReference("mattermostConfig.openclawGroupPolicy", { inputs })?.value,
    ).toBe("allowlist");
    expect(
      resolveMattermostTemplateReference("mattermostConfig.openclawGroups", { inputs })?.value,
    ).toEqual({
      "town-square": { requireMention: true },
      ops: { requireMention: true },
    });
  });

  it("opens OpenClaw channels when mention mode is disabled without a channel allowlist", () => {
    const inputs = [input("requireMention", "mattermostConfig.requireMention", "0")];

    expect(
      resolveMattermostTemplateReference("mattermostConfig.openclawChatmode", { inputs })?.value,
    ).toBe("onmessage");
    expect(
      resolveMattermostTemplateReference("mattermostConfig.openclawGroupPolicy", { inputs })?.value,
    ).toBe("open");
    expect(
      resolveMattermostTemplateReference("mattermostConfig.openclawGroups", { inputs })?.value,
    ).toEqual({ "*": { requireMention: false } });
  });

  it("resolves shared list values without inventing empty arrays", () => {
    const inputs: SandboxMessagingInputReference[] = [
      input("requireMention", "mattermostConfig.requireMention", "0"),
      input("allowedChannels", "mattermostConfig.allowedChannels", "town-square, ops"),
    ];

    expect(
      resolveMattermostTemplateReference("mattermostConfig.requireMention", { inputs })?.value,
    ).toBe(false);
    expect(
      resolveMattermostTemplateReference("mattermostConfig.allowedChannels.values", { inputs })
        ?.value,
    ).toEqual(["town-square", "ops"]);
    expect(
      resolveMattermostTemplateReference("mattermostConfig.allowedChannels.csv", { inputs })?.value,
    ).toBe("town-square,ops");
  });
});
