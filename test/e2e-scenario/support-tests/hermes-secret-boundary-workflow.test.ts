// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

it("routes Hermes sandbox secret-boundary selective dispatch to its free-standing Vitest job", () => {
  const inventory = readFreeStandingJobsInventory();

  expect(inventory.allowedJobs).toContain("hermes-sandbox-secret-boundary-vitest");
  expect(inventory.scenarioToJob.get("hermes-sandbox-secret-boundary")).toBe(
    "hermes-sandbox-secret-boundary-vitest",
  );
  expect(
    evaluateE2eVitestWorkflowDispatchSelectors({
      scenarios: "hermes-sandbox-secret-boundary",
    }),
  ).toMatchObject({
    valid: true,
    liveScenariosRuns: false,
    selectedFreeStandingJobs: ["hermes-sandbox-secret-boundary-vitest"],
    registryScenarios: [],
  });
  expect(
    evaluateE2eVitestWorkflowDispatchSelectors({
      jobs: "hermes-sandbox-secret-boundary-vitest",
    }),
  ).toMatchObject({
    valid: true,
    liveScenariosRuns: false,
    selectedFreeStandingJobs: ["hermes-sandbox-secret-boundary-vitest"],
    registryScenarios: [],
  });
});
