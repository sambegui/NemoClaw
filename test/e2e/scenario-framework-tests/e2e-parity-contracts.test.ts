// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  PARITY_STATUSES,
  inferPreviewParityStatus,
  renderLegacyContractCoverageReport,
  validateParityInventory,
  type ParityInventoryEntry,
} from "../runtime/resolver/parity.ts";

function completeEntry(overrides: Partial<ParityInventoryEntry> = {}): ParityInventoryEntry {
  return {
    legacyScript: "test/e2e/test-full-e2e.sh",
    assertionId: "full.e2e.agent.response",
    owner: "scenario-framework",
    sourceAudit: "current-main-e2e-coverage-audit.md#top-level-e2e-assertion-audit",
    status: "mapped-hermetic",
    contract: {
      environment: { kind: "sandbox", requirements: ["docker"] },
      manifest: { scenarioId: "ubuntu-repo-cloud-openclaw" },
      fixtures: [{ id: "fake-openai", cleanup: "teardown" }],
      runtimeActions: [{ id: "onboard.openclaw", order: 1 }],
      assertions: [
        {
          assertionId: "full.e2e.agent.response",
          implementation: "validation_suites/inference/cloud/01-chat-completion.sh",
          evidencePath: ".e2e/assertions/full-e2e-agent-response.json",
          boundary: "sandbox",
        },
      ],
    },
    ...overrides,
  };
}

describe("E2E parity contract foundation", () => {
  it("test_should_accept_only_supported_parity_statuses", () => {
    expect(PARITY_STATUSES).toEqual([
      "mapped-live",
      "mapped-hermetic",
      "partial",
      "metadata-only",
      "retired",
      "deferred",
    ]);

    const valid = validateParityInventory({ entries: [completeEntry()] });
    expect(valid.ok).toBe(true);

    const invalid = validateParityInventory({
      entries: [completeEntry({ status: "preview-only" as ParityInventoryEntry["status"] })],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join("\n")).toMatch(/unsupported parity status.*preview-only/);
  });

  it("test_should_label_preview_only_contract_as_metadata_only", () => {
    const status = inferPreviewParityStatus({
      environment: { kind: "sandbox" },
      manifest: { scenarioId: "ubuntu-repo-cloud-openclaw" },
      assertions: [],
    });
    expect(status).toBe("metadata-only");
    const report = validateParityInventory({
      entries: [completeEntry({ status, contract: { environment: {}, manifest: {}, assertions: [] } })],
    });
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(false);
  });

  it("test_should_reject_mapped_parity_without_real_assertion_step", () => {
    const report = validateParityInventory({
      entries: [
        completeEntry({
          status: "mapped-live",
          contract: {
            environment: { kind: "sandbox" },
            manifest: { scenarioId: "s" },
            assertions: [
              {
                assertionId: "preview.only",
                implementation: "preview",
                evidencePath: ".e2e/preview.json",
                boundary: "metadata",
                previewOnly: true,
              },
            ],
          },
        }),
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/real assertion step/);
  });

  it("test_should_reject_mapped_parity_without_setup_contract", () => {
    const report = validateParityInventory({
      entries: [
        completeEntry({
          contract: {
            assertions: [
              {
                assertionId: "missing.setup",
                implementation: "validation_suites/assert/inference-works.sh",
                evidencePath: ".e2e/assertions/missing-setup.json",
                boundary: "sandbox",
              },
            ],
          },
        }),
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/missing contract part: environment/);
    expect(report.errors.join("\n")).toMatch(/missing contract part: manifest/);
  });

  it("test_should_require_evidence_path_and_stable_assertion_id", () => {
    const report = validateParityInventory({
      entries: [
        completeEntry({
          contract: {
            environment: {},
            manifest: {},
            assertions: [
              {
                assertionId: "",
                implementation: "validation_suites/assert/inference-works.sh",
                evidencePath: "",
                boundary: "sandbox",
              },
            ],
          },
        }),
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/assertionId/);
    expect(report.errors.join("\n")).toMatch(/evidencePath/);
  });

  it("test_should_require_retired_rationale", () => {
    const report = validateParityInventory({
      entries: [completeEntry({ status: "retired", rationale: undefined })],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/retired.*rationale/);
  });

  it("test_should_render_legacy_script_contract_coverage_report", () => {
    const md = renderLegacyContractCoverageReport([
      completeEntry({ status: "mapped-hermetic" }),
      completeEntry({
        legacyScript: "test/e2e/test-gateway-health-honest.sh",
        assertionId: "gateway.health.honest",
        status: "metadata-only",
        contract: { environment: { kind: "host" }, noManifestReason: "host-only" },
      }),
    ]);
    expect(md).toContain("| Legacy script | Environment | Manifest/no-manifest | Fixtures | Runtime actions | Assertions | Status |");
    expect(md).toContain("test/e2e/test-full-e2e.sh");
    expect(md).toContain("test/e2e/test-gateway-health-honest.sh");
    expect(md).toMatch(/metadata-only/);
  });
});
