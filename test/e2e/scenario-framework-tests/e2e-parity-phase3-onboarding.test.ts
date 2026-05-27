// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import path from "node:path";

import { getPhaseParityEntries } from "../runtime/resolver/parity-catalog.ts";
import { validateParityInventory } from "../runtime/resolver/parity.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PHASE3_SCRIPTS = [
  "test/e2e/test-full-e2e.sh",
  "test/e2e/test-cloud-onboard-e2e.sh",
  "test/e2e/test-cloud-inference-e2e.sh",
  "test/e2e/test-double-onboard.sh",
  "test/e2e/test-onboard-negative-paths.sh",
  "test/e2e/test-onboard-resume.sh",
  "test/e2e/test-onboard-repair.sh",
  "test/e2e/test-launchable-smoke.sh",
  "test/e2e/test-spark-install.sh",
];

describe("Phase 3 onboarding and installer parity", () => {
  it("test_should_close_phase3_only_when_all_assigned_behaviors_are_mapped_or_retired", () => {
    const entries = getPhaseParityEntries(3);
    expect(entries.map((entry) => entry.legacyScript).sort()).toEqual(PHASE3_SCRIPTS.sort());
    const result = validateParityInventory({ entries, requiredLegacyScripts: PHASE3_SCRIPTS, sourceRoot: REPO_ROOT });
    expect(result.errors).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("test_should_require_distinct_direct_sandbox_and_agent_inference_assertions_for_cloud_openclaw", () => {
    const entry = getPhaseParityEntries(3).find((item) => item.legacyScript === "test/e2e/test-full-e2e.sh");
    expect(entry?.contract?.assertions?.map((assertion) => assertion.assertionId)).toEqual(
      expect.arrayContaining([
        "onboarding.cloud.direct-provider-chat",
        "onboarding.cloud.sandbox-inference-local-chat",
        "onboarding.cloud.agent-mediated-response",
      ]),
    );
  });

  it("test_should_keep_public_installer_and_launchable_separate_from_repo_current", () => {
    const entries = getPhaseParityEntries(3);
    expect(entries.find((entry) => entry.legacyScript === "test/e2e/test-launchable-smoke.sh")?.contract?.manifest?.installSource).toBe("launchable");
    expect(entries.find((entry) => entry.legacyScript === "test/e2e/test-spark-install.sh")?.contract?.noManifestReason).toMatch(/setup-only/);
  });

  it("test_should_assert_negative_onboarding_message_no_stack_trace_and_no_side_effects", () => {
    const entry = getPhaseParityEntries(3).find((item) => item.legacyScript === "test/e2e/test-onboard-negative-paths.sh");
    const ids = entry?.contract?.assertions?.map((assertion) => assertion.assertionId) ?? [];
    expect(ids).toEqual(expect.arrayContaining([
      "onboarding.negative.failure-message",
      "onboarding.negative.no-stack-trace",
      "onboarding.negative.no-side-effects",
    ]));
  });
});
