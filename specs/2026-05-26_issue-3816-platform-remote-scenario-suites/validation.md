# Validation Plan: Issue #3816 — Platform/Remote Scenario Suite Migration

Generated from: `specs/2026-05-26_issue-3816-platform-remote-scenario-suites/spec.md`
Test Spec: `specs/2026-05-26_issue-3816-platform-remote-scenario-suites/tests.md`

## Overview

**Feature**: Migrate platform/remote E2E behavior into layered scenario suites with `platform_remote` primitives, stable assertion IDs, complete inventory metadata, runner/secret requirements, and GitHub **E2E / Scenario Runner** evidence on the PR branch.

**Available Tools**: Bash, npm/Vitest, scenario runner scripts, GitHub Actions `E2E / Scenario Runner`, optional `gh` CLI for workflow dispatch and evidence collection.

## Outcome Vocabulary

- **Must pass locally**: deterministic checks that run on a developer workstation or default Ubuntu runner without platform hardware/secrets.
- **Must pass in GitHub E2E scenario workflow**: live scenario jobs expected to be green when required runner/secrets are available on the PR branch.
- **Must fail intentionally**: negative scenarios whose success condition is observing a clear failure/rejection/guidance path, or coverage-only tests that are expected RED on main before implementation.
- **Must skip intentionally**: scenario workflow steps that cannot run because a runner/secret/capability is absent and emit explicit skip/deferred reason.
- **Remain deferred**: in-scope assertions represented in metadata/plan-only but not required live-green until manual/self-hosted platform exists or issue dependency closes.

## Local Commands — Required Pass/Fail/Skip/Deferred Expectations

### Must pass locally on the implementation PR branch

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

Expected result: all commands exit 0. The report must show `platform_remote` inventory rows as `covered`, `new assertion`, `deferred`, or `retired` and must include runner/secret metadata.

### Must pass locally in plan-only mode

These commands must exit 0 and write/print valid plans with expected suites and metadata:

```bash
bash test/e2e/runtime/run-scenario.sh gpu-repo-local-ollama-openclaw --plan-only
bash test/e2e/runtime/run-scenario.sh gpu-repo-local-ollama-openclaw-reonboard --plan-only
bash test/e2e/runtime/run-scenario.sh brev-launchable-cloud-openclaw --plan-only
bash test/e2e/runtime/run-scenario.sh brev-remote-branch-validation --plan-only
bash test/e2e/runtime/run-scenario.sh dgx-spark-repo-install --plan-only
bash test/e2e/runtime/run-scenario.sh dgx-spark-repo-local-ollama-openclaw --plan-only
bash test/e2e/runtime/run-scenario.sh macos-repo-cloud-openclaw --plan-only
bash test/e2e/runtime/run-scenario.sh wsl-repo-cloud-openclaw --plan-only
bash test/e2e/runtime/run-scenario.sh wsl-no-distro-bootstrap-negative --plan-only
bash test/e2e/runtime/run-scenario.sh wsl-fake-gpu-negative --plan-only
bash test/e2e/runtime/run-scenario.sh ubuntu-public-cloud-openclaw-target-ref --plan-only
bash test/e2e/runtime/run-scenario.sh jetson-repo-local-openclaw --plan-only
bash test/e2e/runtime/run-scenario.sh jetson-forced-gpu-negative --plan-only
```

If an implementation intentionally chooses different final scenario IDs, update this validation file and the spec inventory mappings in the same PR. Do not drop the scenario coverage requirement.

### Must pass locally in dry-run suite mode

With a seeded temporary `E2E_CONTEXT_DIR/context.env` fixture per suite, these suites must exit 0 in dry-run and emit stable IDs:

```bash
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-gpu-ollama
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-ollama-proxy
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-gpu-cleanup
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-gpu-reonboard
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-launchable
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-brev-branch
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-spark-install
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-spark-runtime
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-macos
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-wsl
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-public-install
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-jetson
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh platform-remote-metadata
```

Expected result: each command exits 0; output includes the suite’s `expected.platform_remote.*` assertion IDs; no raw `NVIDIA_API_KEY`, Brev token, proxy token, or bearer token appears.

### Must fail intentionally in local negative/fixture tests

These tests should include fixture cases that fail and assert the failure is classified correctly:

- Missing `context.env` or required context key causes `platform_remote.sh` helper invocation to fail with the missing key named.
- Unsupported inventory classification fails schema validation.
- A `covered` or `new assertion` row without `expected.platform_remote.*` ID fails metadata hygiene.
- A suite emitting an undocumented `expected.platform_remote.*` ID fails metadata hygiene.
- Negative WSL fake-GPU fixture passes by observing NVIDIA GPU preflight rejection.
- Negative Jetson forced-GPU fixture passes by observing fail-fast guidance.

These are intentional RED fixture paths inside tests; the test process itself must exit 0 after confirming the expected failures.

## GitHub E2E Scenario Workflow Checks

Use the **E2E / Scenario Runner** workflow (`.github/workflows/e2e-scenarios.yaml`) on the PR branch. Evidence can be collected with manual workflow dispatch, reusable workflow calls, or `gh workflow run` plus linked runs in the PR body.

### Must pass in workflow when required runner/secrets are available

| Scenario | Suite filter | Expected workflow check result | Required runner/secrets |
| --- | --- | --- | --- |
| `ubuntu-public-cloud-openclaw-target-ref` | `platform-remote-public-install` | pass | `ubuntu-latest`, `NVIDIA_API_KEY`, network |
| `brev-launchable-cloud-openclaw` | `platform-remote-launchable` | pass | Ubuntu runner, Brev launchable capability, `NVIDIA_API_KEY`, Brev auth if required |
| `brev-remote-branch-validation` | `platform-remote-brev-branch` | pass for CPU/source-shape rows; GPU live rows skipped/deferred | Ubuntu runner, Brev auth; optional Brev GPU |
| `macos-repo-cloud-openclaw` | `platform-remote-macos` | pass for workflow/platform metadata; Docker-dependent suites skipped explicitly | `macos-26`; `NVIDIA_API_KEY` only if cloud live checks included |
| `wsl-repo-cloud-openclaw` | `platform-remote-wsl` | pass for WSL setup/platform/source-install/recovery checks that runner supports; cloud/Docker checks skip if unavailable | `windows-latest`, WSL2; `NVIDIA_API_KEY` only for cloud live checks |

Suggested dispatch commands:

```bash
gh workflow run "E2E / Scenario Runner" --ref <pr-branch> -f scenario=ubuntu-public-cloud-openclaw-target-ref -f suite_filter=platform-remote-public-install
gh workflow run "E2E / Scenario Runner" --ref <pr-branch> -f scenario=brev-launchable-cloud-openclaw -f suite_filter=platform-remote-launchable
gh workflow run "E2E / Scenario Runner" --ref <pr-branch> -f scenario=brev-remote-branch-validation -f suite_filter=platform-remote-brev-branch
gh workflow run "E2E / Scenario Runner" --ref <pr-branch> -f scenario=macos-repo-cloud-openclaw -f suite_filter=platform-remote-macos
gh workflow run "E2E / Scenario Runner" --ref <pr-branch> -f scenario=wsl-repo-cloud-openclaw -f suite_filter=platform-remote-wsl
```

### Must skip intentionally in workflow when unavailable

| Scenario/assertion family | Expected skip/deferred behavior | Required evidence |
| --- | --- | --- |
| GPU/local Ollama live suites on non-GPU PR runners | skip/deferred, not green omission | Workflow summary names missing self-hosted NVIDIA GPU/Docker CDI runner. |
| Brev GPU bridge live rows (#3959/PR #3960) | deferred until Brev GPU resource and #3959 closure | Coverage report row links issue and runner requirement. |
| DGX Spark live suites | deferred/manual unless DGX Spark self-hosted runner is available | Plan-only success plus metadata names DGX Spark/aarch64/manual runner. |
| Jetson/Tegra live suites | deferred/manual | Plan-only success plus metadata names Jetson/Tegra manual/self-hosted runner. |
| macOS Docker-dependent gateway/sandbox/inference checks on GitHub-hosted macOS | skipped intentionally | Workflow summary names Docker unavailable/optional capability. |
| Live cloud checks missing `NVIDIA_API_KEY` | skipped/deferred, not failed or silently passed | Workflow summary names missing `NVIDIA_API_KEY` without printing it. |

### Must fail intentionally / negative expected-pass in workflow or manual validation

| Scenario | Expected observable behavior | Notes |
| --- | --- | --- |
| `wsl-fake-gpu-negative` | scenario/check passes by asserting WDDM placeholder/non-NVIDIA GPU is rejected by NVIDIA GPU preflight | If no WSL fake-GPU fixture exists in workflow, remain plan-only plus local fixture. |
| `wsl-no-distro-bootstrap-negative` | scenario/check passes by asserting Ubuntu 24.04 is installed/registered or an actionable failure is emitted | Windows ARM/no-distro environment may remain manual/deferred. |
| `jetson-forced-gpu-negative` | scenario/check passes by asserting forced GPU passthrough fails early with guidance | Manual/deferred until Jetson runner exists. |

## Validation Scenarios

### Scenario 1.1: Inventory completeness is machine-validated [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Happy Path

**Given**: Platform/remote metadata includes rows for every assertion in `spec.md`
**When**: `npm test -- test/e2e/scenario-framework-tests/e2e-legacy-assertion-inventory.test.ts` runs
**Then**: The test passes only if every assertion is represented exactly once and classified as `covered`, `new assertion`, `deferred`, or `retired`

**Validation Steps**:
1. **Setup**: Ensure metadata includes all rows from the spec inventory.
2. **Execute**: Run the inventory test.
3. **Verify**: Confirm no missing/duplicate/invalid rows.

**Tools Required**: npm, Vitest

### Scenario 1.2: Inventory simplification is rejected [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Sad Path

**Given**: A fixture removes or merges granular GPU/proxy assertions
**When**: Inventory validation runs
**Then**: Validation fails with the missing assertion names

**Validation Steps**:
1. **Setup**: Fixture with a collapsed proxy row.
2. **Execute**: Run inventory validation against the fixture.
3. **Verify**: Confirm the fixture failure names the omitted rows.

**Tools Required**: Vitest

### Scenario 2.1: Platform remote helper is context-driven and secret-safe [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Happy Path

**Given**: A seeded context with fake secret values
**When**: Platform remote helper tests and dry-run suites run
**Then**: Helpers emit stable IDs, fail clearly on missing context in negative fixtures, and never print raw secrets

**Validation Steps**:
1. **Setup**: Create temporary `E2E_CONTEXT_DIR/context.env` fixtures.
2. **Execute**: Run `e2e-lib-helpers.test.ts` and dry-run suite commands.
3. **Verify**: Check exit codes, IDs, and redaction.

**Tools Required**: Bash, npm/Vitest

### Scenario 3.1: GPU/local Ollama and re-onboard plans are valid [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Happy Path

**Given**: GPU scenario metadata exists
**When**: Plan-only commands for `gpu-repo-local-ollama-openclaw` and `gpu-repo-local-ollama-openclaw-reonboard` run
**Then**: Plans include GPU/Ollama/proxy/re-onboard suites and self-hosted GPU runner requirements

**Validation Steps**:
1. **Setup**: Ensure scenarios and suites are registered.
2. **Execute**: Run both plan-only commands.
3. **Verify**: Inspect plans for suites, IDs, and runner metadata.

**Tools Required**: Bash, scenario runner

### Scenario 3.2: GPU live suite is skipped/deferred without GPU runner [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Sad Path

**Given**: Default PR runner lacks NVIDIA GPU/Docker CDI
**When**: GPU scenario is considered by workflow/reporting
**Then**: It is skipped/deferred with explicit runner requirement instead of silently omitted

**Validation Steps**:
1. **Setup**: Run coverage report or workflow without GPU runner.
2. **Execute**: Inspect report/summary.
3. **Verify**: Missing GPU runner is named.

**Tools Required**: Bash/GitHub Actions

### Scenario 4.1: Launchable and public install prove live cloud path on PR branch [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Happy Path

**Given**: PR branch workflow has `NVIDIA_API_KEY` and required Brev capability
**When**: `brev-launchable-cloud-openclaw` and `ubuntu-public-cloud-openclaw-target-ref` scenario workflows run
**Then**: Launchable and public install suites pass, including target-ref evidence and `openclaw agent --thinking off` assertion

**Validation Steps**:
1. **Setup**: Dispatch GitHub workflow on PR branch.
2. **Execute**: Wait for scenario jobs.
3. **Verify**: Link green workflow runs and summaries in PR body.

**Tools Required**: GitHub Actions, `gh` optional

### Scenario 4.2: Missing `NVIDIA_API_KEY` skips cloud live checks explicitly [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Sad Path

**Given**: Cloud scenario workflow lacks `NVIDIA_API_KEY`
**When**: Live cloud assertions run
**Then**: They skip/defer with missing secret reason and do not print secret values

**Validation Steps**:
1. **Setup**: Dispatch or fixture workflow without secret.
2. **Execute**: Run suite.
3. **Verify**: Summary names missing `NVIDIA_API_KEY`; no secret leak.

**Tools Required**: GitHub Actions or local fixture

### Scenario 5.1: DGX Spark and Jetson remain represented despite manual runners [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Happy Path

**Given**: DGX Spark and Jetson scenarios are not available on default PR infrastructure
**When**: Plan-only and coverage report commands run
**Then**: All Spark/Jetson assertion IDs appear with deferred/manual runner metadata

**Validation Steps**:
1. **Setup**: Ensure metadata includes Spark/Jetson rows.
2. **Execute**: Run plan-only commands and coverage report.
3. **Verify**: Deferred/manual reasons are present.

**Tools Required**: Bash

### Scenario 6.1: macOS and WSL workflow metadata is preserved [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Happy Path

**Given**: Existing macOS and WSL workflows and scenario metadata
**When**: Workflow/schema tests and plan-only commands run
**Then**: macOS maps to `macos-26`, WSL maps to `windows-latest`/WSL2, and Docker optional/skipped semantics are explicit

**Validation Steps**:
1. **Setup**: Ensure workflow and scenario metadata are updated.
2. **Execute**: Run workflow tests and macOS/WSL plan-only commands.
3. **Verify**: Runner mapping and skip metadata are present.

**Tools Required**: npm/Vitest, Bash

### Scenario 6.2: WSL negative platform assertions classify failures correctly [STATUS: passed] [VALIDATED: 414b9517a]
**Type**: Sad Path

**Given**: Fixtures for no-distro and fake-GPU WSL states
**When**: WSL negative suites run
**Then**: The scenarios pass by observing actionable failure/install behavior and fake-GPU rejection

**Validation Steps**:
1. **Setup**: Seed WSL fixture contexts.
2. **Execute**: Run dry-run or fixture-backed suites.
3. **Verify**: Assertions emit expected negative IDs and pass by detecting the expected failure mode.

**Tools Required**: Bash/Vitest; Windows runner optional

## Final PR Acceptance Criteria

The implementation PR cannot be accepted with only local tests. It must include:

1. Local command evidence for all required local pass commands.
2. Plan-only evidence for every new/changed scenario listed above.
3. GitHub **E2E / Scenario Runner** workflow evidence on the PR branch for each runnable platform/remote scenario, with run links in the PR body or validation artifact.
4. Explicit skip/deferred evidence for unavailable GPU, Brev GPU, DGX Spark, Jetson, macOS Docker-dependent, WSL, or secret-gated checks.
5. Any intentional failure/negative scenario documented with the expected failure condition and follow-up issue if it cannot be made green.
6. A coverage report showing every assertion classified exactly once.
7. A review note stating: **Do not simplify assertion coverage; keep one inventory row per assertion from the #3816 comment and added issue-body items.**
