// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { getPhaseParityEntries } from "../runtime/resolver/parity-catalog.ts";
import { validateParityInventory } from "../runtime/resolver/parity.ts";

const SCRIPTS = [
  "test/e2e/test-channels-add-remove.sh",
  "test/e2e/test-channels-stop-start.sh",
  "test/e2e/test-messaging-providers.sh",
  "test/e2e/test-token-rotation.sh",
  "test/e2e/test-telegram-injection.sh",
];

describe("Phase 6 messaging channel lifecycle parity", () => {
  it("phase6_inventory_is_complete_and_mapped", () => {
    const entries = getPhaseParityEntries(6);
    expect(entries.map((e) => e.legacyScript).sort()).toEqual(SCRIPTS.sort());
    const report = validateParityInventory({ entries, requiredLegacyScripts: SCRIPTS });
    expect(report.errors).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("requires_channel_actions_rebuild_matrix_rotation_and_injection_assertions", () => {
    const allIds = getPhaseParityEntries(6).flatMap((e) => e.contract?.assertions?.map((a) => a.assertionId) ?? []);
    expect(allIds).toEqual(expect.arrayContaining([
      "messaging.lifecycle.baseline-no-channel",
      "messaging.lifecycle.add-remove-rebuild-effects",
      "messaging.lifecycle.stop-start-registry-cache",
      "messaging.matrix.openclaw-and-hermes-config",
      "messaging.rotation.changed-provider-only-rebuild",
      "messaging.rotation.same-token-no-rebuild",
      "messaging.telegram.injection-no-exec-no-secret-leak",
    ]));
    const channelEntry = getPhaseParityEntries(6).find((e) => e.legacyScript === "test/e2e/test-channels-add-remove.sh");
    expect(channelEntry?.contract?.runtimeActions?.map((a) => a.id)).toEqual(expect.arrayContaining(["channels.add", "channels.remove", "rebuild"]));
  });
});
