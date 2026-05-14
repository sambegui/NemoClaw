// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  onboardExamples,
  onboardUsage,
  toLegacyOnboardArgs,
} from "../../../dist/lib/commands/onboard/common";
import {
  appendCommonPolicyFlags,
  getPolicyRuntimeBridge,
  policyMutationArgs,
  policyMutationFlags,
  setPolicyRuntimeBridgeFactoryForTest,
} from "../../../dist/lib/commands/sandbox/policy/common";
import {
  buildChannelArgs,
  channelMutationArgs,
  channelMutationFlags,
  getChannelsRuntimeBridge,
  setChannelsRuntimeBridgeFactoryForTest,
} from "../../../dist/lib/commands/sandbox/channels/common";
import {
  buildHostAliasArgs,
  getHostsRuntimeBridge,
  hostAliasAddArgs,
  hostAliasMutationFlags,
  hostAliasSandboxArgs,
  setHostsRuntimeBridgeFactoryForTest,
} from "../../../dist/lib/commands/sandbox/hosts/common";
import {
  getSkillInstallRuntimeBridge,
  setSkillInstallRuntimeBridgeFactoryForTest,
} from "../../../dist/lib/commands/sandbox/skill/common";
import {
  getSnapshotRuntimeBridge,
  sandboxNameArg,
  setSnapshotRuntimeBridgeFactoryForTest,
} from "../../../dist/lib/commands/sandbox/snapshot/common";

describe("command common helpers", () => {
  it("maps onboard flags to legacy argv order", () => {
    expect(onboardUsage[0]).toContain("onboard");
    expect(onboardExamples.length).toBeGreaterThan(0);
    const flags = {
      "non-interactive": true,
      resume: true,
      fresh: true,
      "recreate-sandbox": true,
      gpu: true,
      "no-gpu": true,
      from: "Dockerfile",
      name: "alpha",
      "sandbox-gpu": true,
      "no-sandbox-gpu": true,
      "sandbox-gpu-device": "nvidia.com/gpu=0",
      agent: "hermes",
      "control-ui-port": 19000,
      yes: true,
      "yes-i-accept-third-party-software": true,
    } as Parameters<typeof toLegacyOnboardArgs>[0];

    expect(toLegacyOnboardArgs(flags)).toEqual([
      "--non-interactive",
      "--resume",
      "--fresh",
      "--recreate-sandbox",
      "--gpu",
      "--no-gpu",
      "--from",
      "Dockerfile",
      "--name",
      "alpha",
      "--sandbox-gpu",
      "--no-sandbox-gpu",
      "--sandbox-gpu-device",
      "nvidia.com/gpu=0",
      "--agent",
      "hermes",
      "--control-ui-port",
      "19000",
      "--yes",
      "--yes-i-accept-third-party-software",
    ]);
    expect(toLegacyOnboardArgs({})).toEqual([]);
  });

  it("builds policy mutation args and exposes policy runtime bridges", async () => {
    const args: string[] = ["preset"];
    appendCommonPolicyFlags(args, { yes: true, force: true, "dry-run": true });
    expect(args).toEqual(["preset", "--yes", "--force", "--dry-run"]);
    expect(policyMutationArgs.sandboxName.required).toBe(true);
    expect(policyMutationFlags.yes.char).toBe("y");

    const sandboxPolicyAdd = vi.fn();
    const sandboxPolicyRemove = vi.fn();
    setPolicyRuntimeBridgeFactoryForTest(() => ({ sandboxPolicyAdd, sandboxPolicyRemove }));
    await getPolicyRuntimeBridge().sandboxPolicyAdd("alpha", ["preset"]);
    await getPolicyRuntimeBridge().sandboxPolicyRemove("alpha", ["preset"]);
    expect(sandboxPolicyAdd).toHaveBeenCalledWith("alpha", ["preset"]);
    expect(sandboxPolicyRemove).toHaveBeenCalledWith("alpha", ["preset"]);
  });

  it("builds channel args and exposes channel runtime bridges", async () => {
    expect(buildChannelArgs("telegram", { "dry-run": true })).toEqual(["telegram", "--dry-run"]);
    expect(buildChannelArgs(undefined, {})).toEqual([]);
    expect(channelMutationArgs.channel.required).toBe(true);
    expect(channelMutationFlags["dry-run"].description).toContain("Preview");

    const bridge = {
      sandboxChannelsAdd: vi.fn(),
      sandboxChannelsRemove: vi.fn(),
      sandboxChannelsStart: vi.fn(),
      sandboxChannelsStop: vi.fn(),
    };
    setChannelsRuntimeBridgeFactoryForTest(() => bridge);
    await getChannelsRuntimeBridge().sandboxChannelsAdd("alpha", ["telegram"]);
    await getChannelsRuntimeBridge().sandboxChannelsRemove("alpha", ["telegram"]);
    await getChannelsRuntimeBridge().sandboxChannelsStart("alpha", ["telegram"]);
    await getChannelsRuntimeBridge().sandboxChannelsStop("alpha", ["telegram"]);
    expect(bridge.sandboxChannelsAdd).toHaveBeenCalledWith("alpha", ["telegram"]);
    expect(bridge.sandboxChannelsRemove).toHaveBeenCalledWith("alpha", ["telegram"]);
    expect(bridge.sandboxChannelsStart).toHaveBeenCalledWith("alpha", ["telegram"]);
    expect(bridge.sandboxChannelsStop).toHaveBeenCalledWith("alpha", ["telegram"]);
  });

  it("builds host alias args and exposes host runtime bridges", () => {
    expect(buildHostAliasArgs(["api.local", undefined, "10.0.0.1"], { "dry-run": true })).toEqual([
      "api.local",
      "10.0.0.1",
      "--dry-run",
    ]);
    expect(hostAliasSandboxArgs.sandboxName.required).toBe(true);
    expect(hostAliasAddArgs.ip.required).toBe(true);
    expect(hostAliasMutationFlags["dry-run"].description).toContain("Preview");

    const bridge = {
      addSandboxHostAlias: vi.fn(),
      listSandboxHostAliases: vi.fn(),
      removeSandboxHostAlias: vi.fn(),
    };
    setHostsRuntimeBridgeFactoryForTest(() => bridge);
    getHostsRuntimeBridge().addSandboxHostAlias("alpha", ["api.local"]);
    getHostsRuntimeBridge().listSandboxHostAliases("alpha");
    getHostsRuntimeBridge().removeSandboxHostAlias("alpha", ["api.local"]);
    expect(bridge.addSandboxHostAlias).toHaveBeenCalledWith("alpha", ["api.local"]);
    expect(bridge.listSandboxHostAliases).toHaveBeenCalledWith("alpha");
    expect(bridge.removeSandboxHostAlias).toHaveBeenCalledWith("alpha", ["api.local"]);
  });

  it("exposes skill install and snapshot runtime bridges", async () => {
    const sandboxSkillInstall = vi.fn();
    setSkillInstallRuntimeBridgeFactoryForTest(() => ({ sandboxSkillInstall }));
    await getSkillInstallRuntimeBridge().sandboxSkillInstall("alpha", ["skill"]);
    expect(sandboxSkillInstall).toHaveBeenCalledWith("alpha", ["skill"]);

    const sandboxSnapshot = vi.fn();
    setSnapshotRuntimeBridgeFactoryForTest(() => ({ sandboxSnapshot }));
    await getSnapshotRuntimeBridge().sandboxSnapshot("alpha", ["list"]);
    expect(sandboxSnapshot).toHaveBeenCalledWith("alpha", ["list"]);
    expect(sandboxNameArg.required).toBe(true);
  });
});
