// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { getPhaseParityEntries } from "../runtime/resolver/parity-catalog.ts";
import { validateParityInventory } from "../runtime/resolver/parity.ts";

const PHASE4_SCRIPTS = [
  "test/e2e/test-bedrock-runtime-compatible-anthropic.sh",
  "test/e2e/test-inference-routing.sh",
  "test/e2e/test-kimi-inference-compat.sh",
  "test/e2e/test-model-router-provider-routed-inference.sh",
  "test/e2e/test-openclaw-inference-switch.sh",
  "test/e2e/test-hermes-inference-switch.sh",
  "test/e2e/test-messaging-compatible-endpoint.sh",
  "test/e2e/test-runtime-overrides.sh",
];

describe("Phase 4 inference provider, routing, and config-shape parity", () => {
  it("phase4_inventory_is_complete_and_mapped", () => {
    const entries = getPhaseParityEntries(4);
    expect(entries.map((entry) => entry.legacyScript).sort()).toEqual(PHASE4_SCRIPTS.sort());
    const report = validateParityInventory({ entries, requiredLegacyScripts: PHASE4_SCRIPTS });
    expect(report.errors).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("test_should_reject_generic_models_health_as_provider_routing_parity", () => {
    const report = validateParityInventory({
      entries: [
        {
          legacyScript: "test/e2e/test-inference-routing.sh",
          assertionId: "generic-health-only",
          owner: "scenario-framework",
          sourceAudit: "audit#phase4",
          status: "mapped-hermetic",
          contract: {
            environment: {},
            manifest: { scenarioId: "openai-openclaw-routing" },
            assertions: [{ assertionId: "generic-health", implementation: "validation_suites/inference/cloud/00-models-health.sh", evidencePath: ".e2e/generic.json", boundary: "sandbox", genericHealthOnly: true }],
          },
        },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/generic health-only/);
  });

  it("test_should_require_bedrock_adapter_health_config_shape_runtime_and_leak_scan", () => {
    const entry = getPhaseParityEntries(4).find((item) => item.legacyScript === "test/e2e/test-bedrock-runtime-compatible-anthropic.sh");
    expect(entry?.contract?.assertions?.map((assertion) => assertion.assertionId)).toEqual(expect.arrayContaining([
      "inference.bedrock.adapter-health",
      "inference.bedrock.config-shape",
      "inference.bedrock.runtime-chat",
      "inference.bedrock.traffic-observed",
      "inference.bedrock.leak-scan",
    ]));
  });

  it("test_should_require_kimi_tool_call_trajectory_assertions", () => {
    const entry = getPhaseParityEntries(4).find((item) => item.legacyScript === "test/e2e/test-kimi-inference-compat.sh");
    expect(entry?.contract?.assertions?.map((assertion) => assertion.assertionId)).toEqual(expect.arrayContaining([
      "inference.kimi.trajectory.hostname",
      "inference.kimi.trajectory.date",
      "inference.kimi.trajectory.uptime",
    ]));
  });

  it("test_should_require_inference_switch_state_registry_config_hash_and_live_request", () => {
    for (const script of ["test/e2e/test-openclaw-inference-switch.sh", "test/e2e/test-hermes-inference-switch.sh"]) {
      const entry = getPhaseParityEntries(4).find((item) => item.legacyScript === script);
      expect(entry?.contract?.assertions?.map((assertion) => assertion.assertionId)).toEqual(expect.arrayContaining([
        "inference.switch.route-state",
        "inference.switch.registry-session-state",
        "inference.switch.config-hash-shape",
        "inference.switch.post-switch-live-request",
      ]));
    }
  });
});
