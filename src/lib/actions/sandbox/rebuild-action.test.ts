// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const getSandbox = vi.fn();
const prompt = vi.fn();
const checkAgentVersion = vi.fn();

let rebuildSandbox: typeof import("../../../../dist/lib/actions/sandbox/rebuild").rebuildSandbox;

function loadRebuildAction(): void {
  const mocks = {
    "../../../../dist/lib/state/registry": { getSandbox, updateSandbox: vi.fn(), registerSandbox: vi.fn() },
    "../../../../dist/lib/credentials/store": { prompt },
    "../../../../dist/lib/sandbox/version": { checkAgentVersion },
    "../../../../dist/lib/adapters/openshell/resolve": { resolveOpenshell: () => null },
    "../../../../dist/lib/state/onboard-session": { loadSession: () => null, updateSession: vi.fn() },
    "../../../../dist/lib/state/sandbox-session": { createSystemDeps: () => ({}), getActiveSandboxSessions: () => ({ detected: false, sessions: [] }) },
    "../../../../dist/lib/inference/nim": { stopNimContainer: vi.fn(), nimStatus: () => ({ running: false }) },
    "../../../../dist/lib/policy": { getAppliedPresets: () => [], applyPreset: vi.fn() },
    "../../../../dist/lib/actions/sandbox/destroy": { removeSandboxRegistryEntry: vi.fn() },
    "../../../../dist/lib/actions/sandbox/process-recovery": { executeSandboxCommand: vi.fn() },
    "../../../../dist/lib/agent/onboard": { ensureAgentBaseImage: () => ({ built: false, imageTag: null }) },
    "../../../../dist/lib/agent/defs": { loadAgent: () => null },
    "../../../../dist/lib/adapters/openshell/runtime": { captureOpenshell: vi.fn(), runOpenshell: vi.fn() },
    "../../../../dist/lib/domain/sandbox/destroy": { getSandboxDeleteOutcome: () => ({ deleted: true }) },
    "../../../../dist/lib/state/sandbox": { backupSandboxState: vi.fn(), restoreSandboxState: vi.fn() },
  };
  for (const [id, exports] of Object.entries(mocks)) {
    const resolved = require.resolve(id);
    delete require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
  }
  const actionPath = require.resolve("../../../../dist/lib/actions/sandbox/rebuild");
  delete require.cache[actionPath];
  ({ rebuildSandbox } = require(actionPath));
}

describe("sandbox rebuild action early paths", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    checkAgentVersion.mockReturnValue({ sandboxVersion: "1.0.0", expectedVersion: "1.0.0", isStale: false });
    prompt.mockResolvedValue("n");
    loadRebuildAction();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("throws instead of exiting when the sandbox is missing and throwOnError is set", async () => {
    getSandbox.mockReturnValue(null);
    await expect(rebuildSandbox("missing", {}, { throwOnError: true })).rejects.toThrow("not found in registry");
  });

  it("rejects multi-agent sandboxes before destructive work", async () => {
    getSandbox.mockReturnValue({ name: "alpha", agents: [{ name: "a" }, { name: "b" }] });
    await expect(rebuildSandbox("alpha", { yes: true }, { throwOnError: true })).rejects.toThrow(
      "Multi-agent sandbox rebuild is not yet supported",
    );
  });

  it("returns without destructive work when the confirmation is declined", async () => {
    getSandbox.mockReturnValue({ name: "alpha", provider: "openai", policies: [] });
    await rebuildSandbox("alpha", {}, { throwOnError: true });
    expect(prompt).toHaveBeenCalledWith("  Proceed? [y/N]: ");
  });
});
