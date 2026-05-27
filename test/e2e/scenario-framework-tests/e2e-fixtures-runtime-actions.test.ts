// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runRuntimeActions,
  setupFixture,
  teardownFixture,
} from "../runtime/resolver/fixtures-actions.ts";
import { loadMetadataFromObjects } from "../runtime/resolver/load.ts";
import { resolveScenario } from "../runtime/resolver/plan.ts";
import { validateParityInventory, type ParityInventoryEntry } from "../runtime/resolver/parity.ts";

function tmpdir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

describe("Phase 2 fixture and runtime action primitives", () => {
  it("test_should_start_and_teardown_fake_service_fixture_with_evidence", async () => {
    const dir = tmpdir("e2e-fixture-openai-");
    try {
      const fixture = await setupFixture(
        { id: "fake-openai", type: "fake-service", service: "openai-compatible" },
        { contextDir: dir },
      );
      expect(fixture.outputs.endpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      expect(fs.existsSync(fixture.evidencePath)).toBe(true);
      const teardown = await teardownFixture(fixture);
      expect(teardown.ok).toBe(true);
      expect(fs.existsSync(teardown.evidencePath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test_should_stage_and_cleanup_home_state_fixture", async () => {
    const dir = tmpdir("e2e-fixture-state-");
    try {
      const fixture = await setupFixture(
        {
          id: "home-state",
          type: "home-state",
          files: {
            "sandboxes.json": "{}",
            "onboard-session.json": "{\"step\":\"credentials\"}",
            "credentials.json": "{\"providers\":[]}",
            "providers/nvidia.json": "{\"provider\":\"nvidia\"}",
          },
        },
        { contextDir: dir, homeDir: path.join(dir, "home") },
      );
      for (const file of Object.keys(fixture.outputs.files as Record<string, string>)) {
        expect(fs.existsSync(file), file).toBe(true);
      }
      await teardownFixture(fixture);
      for (const file of Object.keys(fixture.outputs.files as Record<string, string>)) {
        expect(fs.existsSync(file), file).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test_should_run_runtime_actions_in_declared_order", async () => {
    const dir = tmpdir("e2e-actions-");
    try {
      const result = await runRuntimeActions(
        [
          { id: "channels.add", order: 2, args: { channel: "telegram" } },
          { id: "inference.set", order: 1, args: { provider: "nvidia-prod" } },
          { id: "snapshot.create", order: 3 },
          { id: "rebuild", order: 4 },
        ],
        { contextDir: dir },
      );
      expect(result.evidence.map((item) => item.id)).toEqual([
        "inference.set",
        "channels.add",
        "snapshot.create",
        "rebuild",
      ]);
      expect(result.outputs["channels.add"]?.channel).toBe("telegram");
      for (const item of result.evidence) {
        expect(fs.existsSync(item.evidencePath), item.id).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test_should_represent_gateway_health_honest_and_drift_preflight_as_hermetic_contracts", () => {
    const entries: ParityInventoryEntry[] = [
      hermeticGatewayEntry("test/e2e/test-gateway-health-honest.sh", "gateway.health.honest"),
      hermeticGatewayEntry("test/e2e/test-gateway-drift-preflight.sh", "gateway.drift.preflight"),
    ];
    const report = validateParityInventory({ entries });
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(true);
    for (const entry of entries) {
      expect(entry.contract?.noManifestReason).toBe("host-only hermetic gateway contract");
    }
  });

  it("test_should_require_restore_for_hosts_docker_blueprint_and_policy_mutations", () => {
    for (const type of [
      "hosts-edit",
      "docker-daemon-mutation",
      "blueprint-mutation",
      "policy-mutation",
    ]) {
      const report = validateParityInventory({
        entries: [
          hermeticGatewayEntry("test/e2e/test-gateway-drift-preflight.sh", `danger.${type}`, {
            fixtures: [{ id: `fixture-${type}`, type }],
          }),
        ],
      });
      expect(report.ok, type).toBe(false);
      expect(report.errors.join("\n")).toMatch(/requires cleanup or restore/);
    }
  });

  it("host_only_scenarios_should_resolve_without_fake_product_manifest", () => {
    const meta = loadMetadataFromObjects({
      scenarios: {
        platforms: { host: { os: "ubuntu", execution_target: "local" } },
        installs: { none: { method: "host-only" } },
        runtimes: { host: { container_engine: "none" } },
        onboarding: { none: { path: "host-only", agent: "none", provider: "none" } },
        setup_scenarios: {
          "gateway-health-honest": {
            scenario_type: "host-only",
            no_manifest_reason: "host-only gateway probe",
            dimensions: { platform: "host", install: "none", runtime: "host", onboarding: "none" },
            expected_state: "host-ready",
            suites: ["gateway-health-honest"],
          },
        },
      },
      expectedStates: { expected_states: { "host-ready": { host: { available: true } } } },
      suites: {
        suites: {
          "gateway-health-honest": {
            requires_state: { "host.available": true },
            steps: [{ id: "gateway-health-honest", script: "gateway/00-health-honest.sh" }],
          },
        },
      },
    });
    const plan = resolveScenario("gateway-health-honest", meta);
    expect(plan.scenario_type).toBe("host-only");
    expect(plan.no_manifest_reason).toBe("host-only gateway probe");
    expect(plan.suites[0]?.steps[0]?.id).toBe("gateway-health-honest");
  });
});

function hermeticGatewayEntry(
  legacyScript: string,
  assertionId: string,
  contractOverrides: Partial<NonNullable<ParityInventoryEntry["contract"]>> = {},
): ParityInventoryEntry {
  return {
    legacyScript,
    assertionId,
    owner: "scenario-framework",
    sourceAudit: "current-main-e2e-coverage-audit.md#setup-and-onboarding-manifest-parity-audit",
    status: "mapped-hermetic",
    contract: {
      environment: { kind: "host", tools: ["bash", "node"] },
      noManifestReason: "host-only hermetic gateway contract",
      fixtures: [{ id: "fake-openshell-gateway", type: "fake-service", cleanup: "teardown" }],
      runtimeActions: [],
      assertions: [
        {
          assertionId,
          implementation: "validation_suites/gateway/00-health-honest.sh",
          evidencePath: `.e2e/assertions/${assertionId}.json`,
          boundary: "fake-service",
        },
      ],
      ...contractOverrides,
    },
  };
}
