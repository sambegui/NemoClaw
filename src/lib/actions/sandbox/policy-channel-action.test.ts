// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const listPresets = vi.fn();
const getAppliedPresets = vi.fn();
const getGatewayPresets = vi.fn();
const listCustomPresets = vi.fn();
const loadPreset = vi.fn();
const getPresetEndpoints = vi.fn();
const applyPreset = vi.fn();
const removePreset = vi.fn();
const selectFromList = vi.fn();
const selectForRemoval = vi.fn();
const getMessagingPresetWarning = vi.fn();
const prompt = vi.fn();
const getDisabledChannels = vi.fn();
const setChannelDisabled = vi.fn();

let actions: typeof import("../../../../dist/lib/actions/sandbox/policy-channel");

function loadPolicyChannelActions(): void {
  const mocks = {
    "../../../../dist/lib/policy": {
      listPresets,
      getAppliedPresets,
      getGatewayPresets,
      listCustomPresets,
      loadPreset,
      getPresetEndpoints,
      applyPreset,
      removePreset,
      selectFromList,
      selectForRemoval,
      getMessagingPresetWarning,
      loadPresetFromFile: vi.fn(),
      applyPresetContent: vi.fn(),
    },
    "../../../../dist/lib/credentials/store": { prompt, getCredential: vi.fn() },
    "../../../../dist/lib/state/registry": {
      getDisabledChannels,
      setChannelDisabled,
      getSandbox: vi.fn(),
      updateSandbox: vi.fn(),
      getCustomPolicies: () => [],
    },
    "../../../../dist/lib/gateway-runtime-action": { recoverNamedGatewayRuntime: vi.fn() },
    "../../../../dist/lib/adapters/openshell/runtime": { runOpenshell: vi.fn() },
    "../../../../dist/lib/actions/sandbox/rebuild": { rebuildSandbox: vi.fn() },
    "../../../../dist/lib/onboard": { isNonInteractive: () => process.env.NEMOCLAW_NON_INTERACTIVE === "1" },
    "../../../../dist/lib/onboard/providers": { upsertMessagingProviders: vi.fn() },
    "../../../../dist/lib/sandbox/channels": require("../../../../dist/lib/sandbox/channels"),
  };
  for (const [id, exports] of Object.entries(mocks)) {
    const resolved = require.resolve(id);
    delete require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
  }
  const actionPath = require.resolve("../../../../dist/lib/actions/sandbox/policy-channel");
  delete require.cache[actionPath];
  actions = require(actionPath);
}

describe("sandbox policy/channel actions", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    delete process.env.NEMOCLAW_NON_INTERACTIVE;
    vi.resetAllMocks();
    listPresets.mockReturnValue([{ name: "github", description: "GitHub" }]);
    listCustomPresets.mockReturnValue([]);
    getAppliedPresets.mockReturnValue([]);
    getGatewayPresets.mockReturnValue([]);
    loadPreset.mockReturnValue("allow:\n- github.com");
    getPresetEndpoints.mockReturnValue(["github.com"]);
    getMessagingPresetWarning.mockReturnValue(null);
    applyPreset.mockReturnValue(true);
    removePreset.mockReturnValue(true);
    prompt.mockResolvedValue("y");
    getDisabledChannels.mockReturnValue([]);
    setChannelDisabled.mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message ?? "")));
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => errors.push(String(message ?? "")));
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    loadPolicyChannelActions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEMOCLAW_NON_INTERACTIVE;
  });

  it("lists policy registry/gateway drift", () => {
    getAppliedPresets.mockReturnValue(["github"]);
    getGatewayPresets.mockReturnValue([]);
    actions.listSandboxPolicies("alpha");
    expect(logs.join("\n")).toContain("recorded locally, not active on gateway");
  });

  it("adds a named policy with endpoint preview and confirmation", async () => {
    await actions.addSandboxPolicy("alpha", ["github"]);
    expect(prompt).toHaveBeenCalledWith("  Apply 'github' to sandbox 'alpha'? [Y/n]: ");
    expect(applyPreset).toHaveBeenCalledWith("alpha", "github");
    expect(logs.join("\n")).toContain("Endpoints that would be opened: github.com");
  });

  it("supports policy dry-run without applying", async () => {
    await actions.addSandboxPolicy("alpha", ["github", "--dry-run"]);
    expect(applyPreset).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("--dry-run: no changes applied");
  });

  it("rejects non-interactive policy add without a preset", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    await expect(actions.addSandboxPolicy("alpha", [])).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("Non-interactive mode requires a preset name");
  });

  it("removes a policy with endpoint preview", async () => {
    getAppliedPresets.mockReturnValue(["github"]);
    await actions.removeSandboxPolicy("alpha", ["github", "--yes"]);
    expect(removePreset).toHaveBeenCalledWith("alpha", "github");
    expect(logs.join("\n")).toContain("Endpoints that would be removed: github.com");
  });

  it("lists known messaging channels", () => {
    actions.listSandboxChannels("alpha");
    expect(logs.join("\n")).toContain("Known messaging channels for sandbox 'alpha'");
    expect(logs.join("\n")).toContain("slack");
  });

  it("validates channel names for add/remove", async () => {
    await expect(actions.addSandboxChannel("alpha", [])).rejects.toThrow("exit:1");
    await expect(actions.removeSandboxChannel("alpha", ["unknown"])).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("Valid channels");
  });

  it("supports channel add/remove dry-run", async () => {
    await actions.addSandboxChannel("alpha", ["slack", "--dry-run"]);
    await actions.removeSandboxChannel("alpha", ["slack", "--dry-run"]);
    expect(logs.join("\n")).toContain("would enable channel 'slack'");
    expect(logs.join("\n")).toContain("would remove channel 'slack'");
  });

  it("starts and stops channels through registry flags", async () => {
    await actions.stopSandboxChannel("alpha", ["slack", "--dry-run"]);
    expect(logs.join("\n")).toContain("would stop channel 'slack'");

    logs = [];
    getDisabledChannels.mockReturnValue(["slack"]);
    await actions.startSandboxChannel("alpha", ["slack"]);
    expect(setChannelDisabled).toHaveBeenCalledWith("alpha", "slack", false);
    expect(logs.join("\n")).toContain("Marked slack enabled");
  });
});
