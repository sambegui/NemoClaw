// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { resolveScenario, type ResolverInput } from "../runtime/resolver/plan.ts";
import { loadMetadataFromDir, loadMetadataFromObjects } from "../runtime/resolver/load.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e");

function realMetadata(): ResolverInput {
  return loadMetadataFromDir(E2E_DIR);
}

describe("E2E scenario resolver", () => {
  it("should_resolve_valid_scenario", () => {
    const meta = realMetadata();
    const plan = resolveScenario("ubuntu-repo-cloud-openclaw", meta);
    expect(plan.scenario_id).toBe("ubuntu-repo-cloud-openclaw");
    expect(plan.dimensions.platform.id).toBe("ubuntu-local");
    expect(plan.dimensions.install.id).toBe("repo-current");
    expect(plan.dimensions.runtime.id).toBe("docker-running");
    expect(plan.dimensions.onboarding.id).toBe("cloud-openclaw");
    expect(plan.expected_state.id).toBe("cloud-openclaw-ready");
    const suiteIds = plan.suites.map((s) => s.id);
    expect(suiteIds).toEqual(["smoke", "inference", "credentials"]);
    // each suite should carry its ordered steps with resolved scripts
    expect(plan.suites[0].steps.length).toBeGreaterThan(0);
    for (const s of plan.suites) {
      for (const step of s.steps) {
        expect(step.id).toBeTypeOf("string");
        expect(step.script).toMatch(/\.sh$/);
      }
    }
  });

  it("should_resolve_onboard_negative_path_migration_scenarios", () => {
    const meta = realMetadata();
    const custom = resolveScenario("ubuntu-repo-cloud-openclaw-custom-policies", meta);
    expect(custom.dimensions.onboarding.id).toBe("cloud-openclaw-custom-policies");
    expect(custom.expected_state.id).toBe("cloud-openclaw-custom-policies-ready");
    expect(custom.suites.map((s) => s.id)).toContain("onboarding-state");

    const invalidKey = resolveScenario("ubuntu-invalid-nvidia-key-negative", meta);
    expect(invalidKey.expected_state.config.failure).toMatchObject({
      expected: true,
      stage: "onboarding",
      reason: "invalid-nvidia-api-key",
      exit_code: 1,
      no_stack_trace: true,
    });

    const portConflict = resolveScenario("ubuntu-gateway-port-conflict-negative", meta);
    expect(portConflict.expected_state.config.failure).toMatchObject({
      expected: true,
      stage: "onboarding",
      reason: "gateway-port-conflict",
      exit_code: 1,
      no_stack_trace: true,
    });
  });



  it("should_resolve_gpu_platform_remote_scenarios", () => {
    const meta = realMetadata();
    const gpu = resolveScenario("gpu-repo-local-ollama-openclaw", meta);
    expect(gpu.suites.map((s) => s.id)).toEqual(expect.arrayContaining([
      "platform-remote-gpu-ollama",
      "platform-remote-ollama-proxy",
      "platform-remote-gpu-cleanup",
    ]));
    expect(gpu.runner_requirements).toEqual(expect.arrayContaining(["self-hosted-gpu", "docker-cdi"]));
    const reonboard = resolveScenario("gpu-repo-local-ollama-openclaw-reonboard", meta);
    expect(reonboard.suites.map((s) => s.id)).toContain("platform-remote-gpu-reonboard");
    expect(reonboard.runner_requirements).toEqual(expect.arrayContaining(["self-hosted-gpu", "docker-cdi"]));
  });



  it("should_resolve_brev_platform_remote_scenarios", () => {
    const meta = realMetadata();
    const launchable = resolveScenario("brev-launchable-cloud-openclaw", meta);
    expect(launchable.suites.map((s) => s.id)).toContain("platform-remote-launchable");
    expect(launchable.required_secrets).toContain("NVIDIA_API_KEY");
    const branch = resolveScenario("brev-remote-branch-validation", meta);
    expect(branch.suites.map((s) => s.id)).toContain("platform-remote-brev-branch");
    expect(branch.runner_requirements).toEqual(expect.arrayContaining(["brev-api-token"]));
  });



  it("should_resolve_spark_and_jetson_platform_remote_scenarios", () => {
    const meta = realMetadata();
    for (const [id, suite] of [
      ["dgx-spark-repo-install", "platform-remote-spark-install"],
      ["dgx-spark-repo-local-ollama-openclaw", "platform-remote-spark-runtime"],
      ["jetson-repo-local-openclaw", "platform-remote-jetson"],
      ["jetson-forced-gpu-negative", "platform-remote-jetson"],
    ] as const) {
      const plan = resolveScenario(id, meta);
      expect(plan.suites.map((s) => s.id)).toContain(suite);
      expect(plan.runner_requirements).toEqual(expect.arrayContaining(["manual"]));
    }
  });

  it("should_fail_for_unknown_scenario", () => {
    const meta = realMetadata();
    expect(() => resolveScenario("does-not-exist", meta)).toThrow(/does-not-exist/);
  });

  it("should_fail_for_missing_profile_reference", () => {
    const meta = loadMetadataFromObjects({
      scenarios: yaml.load(`
platforms:
  ubuntu-local: { os: ubuntu }
installs:
  repo-current: { method: repo-checkout }
runtimes:
  docker-running: { container_engine: docker }
onboarding:
  cloud-openclaw: { path: cloud, agent: openclaw, provider: nvidia }
setup_scenarios:
  broken:
    dimensions:
      platform: missing-platform
      install: repo-current
      runtime: docker-running
      onboarding: cloud-openclaw
    expected_state: some-state
    suites: [smoke]
`) as object,
      expectedStates: yaml.load(`
expected_states:
  some-state:
    gateway: { health: healthy }
    sandbox: { status: running }
`) as object,
      suites: yaml.load(`
suites:
  smoke:
    requires_state:
      gateway.health: healthy
      sandbox.status: running
    steps:
      - { id: step, script: suites/smoke/step.sh }
`) as object,
    });
    expect(() => resolveScenario("broken", meta)).toThrow(/platform.*missing-platform/);
  });

  it("should_fail_for_missing_expected_state_reference", () => {
    const meta = loadMetadataFromObjects({
      scenarios: yaml.load(`
platforms: { p: {} }
installs: { i: {} }
runtimes: { r: {} }
onboarding: { o: { agent: openclaw, provider: nvidia } }
setup_scenarios:
  s:
    dimensions: { platform: p, install: i, runtime: r, onboarding: o }
    expected_state: ghost
    suites: [smoke]
`) as object,
      expectedStates: yaml.load(`
expected_states:
  real: { gateway: { health: healthy } }
`) as object,
      suites: yaml.load(`
suites:
  smoke:
    steps:
      - { id: step, script: suites/smoke/step.sh }
`) as object,
    });
    expect(() => resolveScenario("s", meta)).toThrow(/expected_state.*ghost/);
  });

  it("should_fail_for_missing_suite_reference", () => {
    const meta = loadMetadataFromObjects({
      scenarios: yaml.load(`
platforms: { p: {} }
installs: { i: {} }
runtimes: { r: {} }
onboarding: { o: { agent: openclaw, provider: nvidia } }
setup_scenarios:
  s:
    dimensions: { platform: p, install: i, runtime: r, onboarding: o }
    expected_state: real
    suites: [smoke, phantom]
`) as object,
      expectedStates: yaml.load(`
expected_states:
  real: { gateway: { health: healthy } }
`) as object,
      suites: yaml.load(`
suites:
  smoke:
    steps:
      - { id: step, script: suites/smoke/step.sh }
`) as object,
    });
    expect(() => resolveScenario("s", meta)).toThrow(/suite.*phantom/);
  });

  it("should_fail_when_suite_requires_state_incompatible_with_scenario_expected_state", () => {
    const meta = loadMetadataFromObjects({
      scenarios: yaml.load(`
platforms: { p: {} }
installs: { i: {} }
runtimes: { r: {} }
onboarding: { o: { agent: openclaw, provider: nvidia } }
setup_scenarios:
  s:
    dimensions: { platform: p, install: i, runtime: r, onboarding: o }
    expected_state: gw-unhealthy
    suites: [smoke]
`) as object,
      expectedStates: yaml.load(`
expected_states:
  gw-unhealthy:
    gateway: { health: unhealthy }
    sandbox: { status: running }
`) as object,
      suites: yaml.load(`
suites:
  smoke:
    requires_state:
      gateway.health: healthy
    steps:
      - { id: step, script: suites/smoke/step.sh }
`) as object,
    });
    expect(() => resolveScenario("s", meta)).toThrow(
      /smoke.*gateway\.health.*healthy.*unhealthy/s,
    );
  });
});

describe("run-scenario.sh --plan-only", () => {
  it("run_scenario_plan_only_should_print_plan", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-plan-"));
    try {
      const result = spawnSync(
        "bash",
        [
          path.join(E2E_DIR, "runtime", "run-scenario.sh"),
          "ubuntu-repo-cloud-openclaw",
          "--plan-only",
        ],
        {
          env: { ...process.env, E2E_CONTEXT_DIR: tmp },
          encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
          cwd: REPO_ROOT,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("ubuntu-repo-cloud-openclaw");
      expect(result.stdout).toContain("cloud-openclaw-ready");
      expect(result.stdout).toContain("smoke");
      expect(result.stdout).toContain("inference");
      const planJsonPath = path.join(tmp, "plan.json");
      expect(fs.existsSync(planJsonPath)).toBe(true);
      const doc = JSON.parse(fs.readFileSync(planJsonPath, "utf8"));
      expect(doc.scenario_id).toBe("ubuntu-repo-cloud-openclaw");
      expect(doc.expected_state.id).toBe("cloud-openclaw-ready");
      expect(Array.isArray(doc.suites)).toBe(true);
      expect(doc.suites.map((s: { id: string }) => s.id)).toContain("smoke");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_scenario_plan_only_should_fail_for_unknown_scenario", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-plan-"));
    try {
      const result = spawnSync(
        "bash",
        [
          path.join(E2E_DIR, "runtime", "run-scenario.sh"),
          "does-not-exist",
          "--plan-only",
        ],
        {
          env: { ...process.env, E2E_CONTEXT_DIR: tmp },
          encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
          cwd: REPO_ROOT,
        },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/does-not-exist/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
