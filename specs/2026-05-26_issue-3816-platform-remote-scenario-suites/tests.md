# Test Specification: Issue #3816 — Platform/Remote Scenario Suite Migration

Generated from: `specs/2026-05-26_issue-3816-platform-remote-scenario-suites/spec.md`

## Test Strategy

Use TDD against the layered scenario framework. Prefer local schema/resolver/source-shape/dry-run tests for PR CI and reserve GPU, Brev, DGX Spark, Jetson, macOS, WSL, and live `NVIDIA_API_KEY` checks for explicit scenario workflow jobs with runner/secret gating.

Primary existing test locations:

- `test/e2e/scenario-framework-tests/e2e-lib-helpers.test.ts`
- `test/e2e/scenario-framework-tests/e2e-suite-runner.test.ts`
- `test/e2e/scenario-framework-tests/e2e-scenario-schema.test.ts`
- `test/e2e/scenario-framework-tests/e2e-scenario-resolver.test.ts`
- `test/e2e/scenario-framework-tests/e2e-coverage-report.test.ts`
- `test/e2e/scenario-framework-tests/e2e-metadata-final-hygiene.test.ts`
- `test/e2e/scenario-framework-tests/e2e-legacy-assertion-inventory.test.ts`
- `test/e2e/scenario-framework-tests/e2e-scenarios-workflow.test.ts`

## Phase 1: Metadata, Schema, and Coverage Inventory - Test Guide

**Existing Tests to Modify:**

- `e2e-legacy-assertion-inventory.test.ts`
  - Current behavior: validates legacy assertion inventory coverage for migrated domains.
  - Required changes: require every #3816 platform/remote assertion row to appear exactly once with classification `covered`, `new assertion`, `deferred`, or `retired`.
- `e2e-coverage-report.test.ts`
  - Required changes: render `platform_remote` domain rows, classifications, stable IDs, runner requirements, secret requirements, and deferred/manual reasons.
- `e2e-metadata-final-hygiene.test.ts`
  - Required changes: require metadata for every emitted `expected.platform_remote.*` ID and reject `covered`/`new assertion` rows without IDs.
- `e2e-scenario-schema.test.ts`
  - Required changes: validate any new resolver-loaded platform/remote inventory schema, classification vocabulary, stable assertion IDs, runner metadata including GPU, Brev, DGX Spark, macOS, WSL, Jetson/manual, and `NVIDIA_API_KEY` requirements.

**New Tests to Create:**

1. `test_should_represent_every_platform_remote_inventory_row`
   - **Input**: Platform/remote expectation metadata and inventory fixture generated from `spec.md`.
   - **Expected**: Every assertion from the issue comment and added issue-body table is present exactly once.
   - **Covers**: No assertion coverage simplification during migration/review.

2. `test_should_reject_invalid_platform_remote_classification`
   - **Input**: Metadata fixture using an unsupported classification such as `maybe`.
   - **Expected**: Resolver/schema validation fails and names allowed values: `covered`, `new assertion`, `deferred`, `retired`.
   - **Covers**: Required classification vocabulary and explicit loader support for any new inventory metadata file.

3. `test_should_require_stable_ids_for_covered_and_new_platform_remote_assertions`
   - **Input**: Metadata fixture with a `covered` row missing `expected.platform_remote.*` ID.
   - **Expected**: Hygiene test fails with the missing inventory row named.
   - **Covers**: Stable assertion ID contract and parity between emitted suite IDs and resolver-loaded metadata.

4. `test_should_render_platform_remote_runner_and_secret_requirements`
   - **Input**: Metadata rows for GPU, Brev, DGX Spark, macOS, WSL, Jetson, and public install.
   - **Expected**: Coverage report includes runner/platform/deferred metadata and `NVIDIA_API_KEY` where required without printing secret values.
   - **Covers**: Metadata preservation.

**Test Implementation Notes:**

- Use the current scenario coverage metadata mechanism under `test/e2e/nemoclaw_scenarios/` and `test/e2e/runtime/resolver/`; do not hand-edit generated parity inventory JSON or reintroduce the removed workflow-level parity-map gate.
- Keep inventory tests local and deterministic; no live platforms or secrets.

## Phase 2: `platform_remote.sh` Primitive Library - Test Guide

**Existing Tests to Modify:**

- `e2e-lib-helpers.test.ts`
  - Add source-safety, strict-mode, context-loading, redaction, missing-context, and dry-run tests for `test/e2e/validation_suites/lib/platform_remote.sh`.
- `e2e-suite-runner.test.ts`
  - Add dry-run suite tests for the new platform/remote suite IDs.

**New Tests to Create:**

1. `test_should_source_platform_remote_helpers_under_strict_shell_mode`
   - **Input**: Bash strict mode sourcing `test/e2e/validation_suites/lib/platform_remote.sh`.
   - **Expected**: Exit 0; core helper functions are defined; sourcing makes the existing `e2e_context_*`, `e2e_env_*`, `e2e_section`, `e2e_pass`, and `e2e_fail` primitives available through the existing runtime libraries.
   - **Covers**: Primitive library exists, is source-safe, and reuses existing context/logging/dry-run primitives rather than introducing parallel helpers.

2. `test_should_fail_clearly_when_platform_remote_context_is_missing`
   - **Input**: Empty `E2E_CONTEXT_DIR` and a context-dependent helper.
   - **Expected**: Non-zero exit with missing `context.env` or key named using the existing `e2e_context_require` failure format; no install/onboard command is invoked.
   - **Covers**: Suites consume context and do not rediscover setup state.

3. `test_should_redact_platform_remote_secret_values`
   - **Input**: Context containing fake `NVIDIA_API_KEY`, Brev token, and proxy token values.
   - **Expected**: Helper output and artifacts omit raw secret values.
   - **Covers**: Secret safety.

4. `test_should_emit_platform_remote_assertion_ids_in_dry_run`
   - **Input**: Seeded context and `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-gpu-ollama`.
   - **Expected**: Exit 0 and emits `expected.platform_remote.*` IDs for the selected suite.
   - **Covers**: Stable ID emission.

## Phase 3: GPU/Ollama and Auth Proxy Suites - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Add dry-run checks for `platform-remote-gpu-ollama`, `platform-remote-ollama-proxy`, `platform-remote-gpu-cleanup`, and `platform-remote-gpu-reonboard`.
- `e2e-scenario-resolver.test.ts`
  - Verify `gpu-repo-local-ollama-openclaw` and `gpu-repo-local-ollama-openclaw-reonboard` include the expected suites and runner requirements.

**New Tests to Create:**

1. `test_should_emit_gpu_ollama_assertion_ids_in_dry_run`
   - **Input**: GPU context fixture with Ollama/proxy values.
   - **Expected**: Dry-run output contains GPU prerequisite, install, GPU proof, provider, model, direct inference, sandbox inference, and cleanup IDs.
   - **Covers**: `test-gpu-e2e.sh` migration rows.

2. `test_should_emit_ollama_proxy_assertion_ids_in_dry_run`
   - **Input**: Context with proxy URL/token path/PID.
   - **Expected**: Dry-run output contains token existence, mode `600`, liveness, unauthenticated rejection, bearer acceptance, topology skip, container reachability, kill/recovery, and recovered-token IDs.
   - **Covers**: Auth proxy migration rows.

3. `test_should_emit_reonboard_token_consistency_ids_in_dry_run`
   - **Input**: Re-onboard context fixture.
   - **Expected**: Dry-run output includes first-onboard, second-onboard, token persistence, token mode, 401 rejection, wrong-token rejection, and post-reonboard inference IDs.
   - **Covers**: #2606/PR #2617 double-onboard regression.

4. `test_should_mark_debug_cleanup_rows_retired`
   - **Input**: Inventory metadata.
   - **Expected**: `SKIP_UNINSTALL=1`, generic pre-cleanup, final cleanup rows are `retired` with rationale.
   - **Covers**: Harness-only behavior is not scenarioized.

## Phase 4: Brev Launchable and Branch Validation - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Add dry-run checks for `platform-remote-launchable` and `platform-remote-brev-branch`.
- `e2e-scenario-resolver.test.ts`
  - Verify `brev-launchable-cloud-openclaw` and `brev-remote-branch-validation` include runner/secret metadata.
- `e2e-scenarios-workflow.test.ts`
  - Verify scenario workflow can dispatch Brev/launchable scenario IDs and preserve input `suite_filter`.

**New Tests to Create:**

1. `test_should_emit_launchable_assertion_ids_in_dry_run`
   - **Input**: Launchable context fixture.
   - **Expected**: IDs cover script presence, bootstrap, CLI/OpenShell, Node compatibility, Docker usability, sentinel, clone/build artifacts, onboard, route, direct NVIDIA `PONG`, sandbox `PONG`, `openclaw agent --thinking off` answer, and destroy cleanup.
   - **Covers**: `test-launchable-smoke.sh` and PR #4039.

2. `test_should_require_nvidia_api_key_metadata_for_live_launchable_inference`
   - **Input**: Launchable scenario metadata.
   - **Expected**: `NVIDIA_API_KEY` is required for direct NVIDIA and sandbox inference assertions; missing secret marks live job skipped/deferred, not silently passed.
   - **Covers**: Secret metadata preservation.

3. `test_should_emit_brev_branch_validation_ids_in_dry_run`
   - **Input**: Brev context fixture.
   - **Expected**: IDs cover registry shape, full suite PASS/no FAIL, deploy CLI readiness, CPU `gpuEnabled: false`, and source-shape GPU proxy-env checks.
   - **Covers**: `brev-e2e.test.ts` platform/remote rows.

4. `test_should_defer_brev_gpu_live_bridge_until_runner_available`
   - **Input**: Metadata for #3959/PR #3960 GPU bridge rows.
   - **Expected**: Live GPU bridge rows are `deferred` with Brev GPU runner requirement and issue reference.
   - **Covers**: Partial current E2E and deferred live validation.

## Phase 5: DGX Spark, Jetson, and Local-Model Platform Suites - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Add dry-run checks for `platform-remote-spark-install`, `platform-remote-spark-runtime`, and `platform-remote-jetson`.
- `e2e-scenario-resolver.test.ts`
  - Verify DGX Spark and Jetson scenarios resolve in `--plan-only` mode with manual/deferred metadata.

**New Tests to Create:**

1. `test_should_emit_spark_install_assertion_ids_in_dry_run`
   - **Input**: DGX Spark install context fixture.
   - **Expected**: IDs cover Linux guard, Docker prerequisite, non-interactive envs, generic installer flow, install exit, `nemoclaw`/`openshell` PATH, and `nemoclaw --help`.
   - **Covers**: `test-spark-install.sh` rows.

2. `test_should_emit_spark_runtime_fix_ids_in_dry_run`
   - **Input**: DGX Spark runtime context fixture.
   - **Expected**: IDs cover #3975, #4178, #4113, #4114, #4177, and PR #3963 behaviors.
   - **Covers**: New DGX Spark/local-model assertions.

3. `test_should_mark_spark_and_jetson_live_rows_deferred_with_manual_runner_metadata`
   - **Input**: Metadata rows for DGX Spark and Jetson.
   - **Expected**: Live execution rows include manual/self-hosted runner requirements and plan-only validation remains required.
   - **Covers**: Deferred environment preservation.

4. `test_should_emit_jetson_negative_assertion_ids_in_dry_run`
   - **Input**: Jetson/Tegra fixture context.
   - **Expected**: IDs cover NVIDIA runtime path and forced-GPU fail-fast guidance, both marked deferred/manual for live runs.
   - **Covers**: PR #4008 and PR #3965.

## Phase 6: macOS, WSL, Workflow Metadata, and Public Installer - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Add dry-run checks for `platform-remote-macos`, `platform-remote-wsl`, `platform-remote-public-install`, and `platform-remote-metadata`.
- `e2e-scenarios-workflow.test.ts`
  - Verify `.github/workflows/e2e-scenarios.yaml` routes `macos-*` to macOS, `wsl-*` to Windows, `gpu-*` to GPU, and `brev-*`/`ubuntu-*` to Ubuntu.
- `e2e-scenario-resolver.test.ts`
  - Verify `macos-repo-cloud-openclaw`, `wsl-repo-cloud-openclaw`, WSL negative plans, and `ubuntu-public-cloud-openclaw-target-ref` resolve with correct metadata.

**New Tests to Create:**

1. `test_should_preserve_macos_and_wsl_workflow_metadata`
   - **Input**: Workflow files and scenario metadata.
   - **Expected**: macOS rows include workflow triggers and `macos-26`; WSL rows include workflow triggers, `windows-latest`, and WSL2.
   - **Covers**: `.github/workflows/macos-e2e.yaml`, `.github/workflows/wsl-e2e.yaml`, PR #4046 metadata.

2. `test_should_emit_wsl_platform_assertion_ids_in_dry_run`
   - **Input**: WSL context fixture.
   - **Expected**: IDs cover source-install OpenShell bootstrap (#3989), no-distro Ubuntu/actionable failure (#3974), idle gateway recovery (#3986), and fake-GPU rejection (#3988).
   - **Covers**: WSL added items.

3. `test_should_emit_public_install_target_ref_ids_in_dry_run`
   - **Input**: Public install context fixture with target ref and clone evidence.
   - **Expected**: IDs cover Docker/API/noninteractive prerequisites, Linux skip metadata, install exit, source isolation, GitHub clone path evidence, target ref used, and toolchain on PATH.
   - **Covers**: PR #4214 and `test-cloud-onboard-e2e.sh` rows.

4. `test_should_retire_openclaw_json_parser_helper_for_platform_remote`
   - **Input**: PR #4038 metadata row.
   - **Expected**: Row is `retired` with rationale that parser helper hardening is not platform/remote behavior.
   - **Covers**: Added issue-body evaluation.

## Phase 7: Plan-Only and Workflow Evidence - Test Guide

**Existing Tests to Modify:**

- `e2e-scenario-resolver.test.ts`
  - Add plan-only fixtures for every new or changed platform/remote scenario.
- `e2e-scenarios-workflow.test.ts`
  - Verify workflow dispatch supports platform/remote scenario IDs and summary reports pass/fail/skip/deferred outcomes.

**New Tests to Create:**

1. `test_should_plan_only_all_platform_remote_scenarios`
   - **Input**: Scenario IDs from spec.
   - **Expected**: `bash test/e2e/runtime/run-scenario.sh <id> --plan-only` exits 0 for each and writes a plan artifact with expected suites.
   - **Covers**: Backward compatibility.

2. `test_should_skip_or_defer_unavailable_platform_remote_live_requirements_explicitly`
   - **Input**: Metadata for missing GPU/Brev/DGX Spark/Jetson/macOS/WSL/secrets.
   - **Expected**: Workflow/report output shows explicit skipped/deferred reason, not green omission.
   - **Covers**: Validation spec pass/fail/skip/deferred requirements.

3. `test_should_require_pr_branch_e2e_scenario_workflow_evidence`
   - **Input**: PR acceptance metadata or validation artifact.
   - **Expected**: Acceptance check requires GitHub **E2E / Scenario Runner** links/results for relevant scenario jobs on the PR branch.
   - **Covers**: Final PR acceptance criteria.

## Recommended Local Test Commands

```bash
npm test -- test/e2e/scenario-framework-tests/e2e-lib-helpers.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-suite-runner.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-scenario-schema.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-scenario-resolver.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-coverage-report.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-metadata-final-hygiene.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-legacy-assertion-inventory.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-scenarios-workflow.test.ts
bash test/e2e/runtime/coverage-report.sh
```

Plan-only commands are enumerated in `validation.md` and must be run after scenario metadata is implemented.
