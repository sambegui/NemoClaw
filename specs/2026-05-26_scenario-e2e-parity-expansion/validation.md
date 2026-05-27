<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validation Plan: Scenario E2E Parity Expansion

Generated from: `specs/2026-05-26_scenario-e2e-parity-expansion/spec.md`
Test Spec: `specs/2026-05-26_scenario-e2e-parity-expansion/tests.md`

## Overview

**Feature**: Expand the hybrid scenario E2E framework so every legacy top-level E2E behavior is represented by an executable scenario contract with setup, fixtures, runtime actions, and real assertions.

**Available Tools**: `npm test`, `npx vitest`, `npm run typecheck:cli`, `npm run build:cli`, Bash, YAML/TypeScript metadata tests, local filesystem checks. Live cloud/GPU/provider scenarios require runner labels and secrets declared in each scenario contract.

## Coverage Summary

- Happy Paths: 23 scenarios
- Sad Paths: 14 scenarios
- Total: 37 scenarios

---

## Phase 1: Parity Contract Foundation - Validation Scenarios

### Scenario 1.1: Preview-only contracts remain metadata-only [STATUS: pending]
**Type**: Happy Path

**Given**: A scenario contract can be previewed and includes discoverable metadata but no real assertion implementation.
**When**: The parity inventory and coverage report are generated.
**Then**: The entry is labeled `metadata-only`, does not count as semantic parity, and the report explains the missing assertion/setup contract.

**Validation Steps**:
1. **Setup**: Bash: create or select a fixture contract with preview metadata only.
2. **Execute**: Vitest: run scenario framework parity/coverage tests.
3. **Verify**: Bash/Vitest: confirm generated report marks status `metadata-only` and complete parity count excludes it.

**Tools Required**: Bash, Vitest.

### Scenario 1.2: Invalid mapped parity claims fail closed [STATUS: pending]
**Type**: Sad Path

**Given**: A parity entry is marked `mapped-live` or `mapped-hermetic` without a real assertion step, setup contract, or evidence path.
**When**: Metadata validation runs.
**Then**: Validation fails and names the legacy script/assertion and missing contract part.

**Validation Steps**:
1. **Setup**: Bash: inject test metadata with an invalid mapped parity claim.
2. **Execute**: Vitest: run parity contract validation.
3. **Verify**: Vitest: assert failure message includes the missing assertion/setup/evidence field.

**Tools Required**: Bash, Vitest.

### Scenario 1.3: Retired entries require reviewer-visible rationale [STATUS: pending]
**Type**: Sad Path

**Given**: A legacy behavior is marked `retired` without rationale.
**When**: Inventory validation runs.
**Then**: Validation fails until rationale and evidence are provided.

**Validation Steps**:
1. **Setup**: Bash: create retired inventory entries with and without rationale.
2. **Execute**: Vitest: run inventory validation.
3. **Verify**: Vitest: unrationalized retired entry fails; rationalized entry passes.

**Tools Required**: Bash, Vitest.

## Phase 2: Environment, Manifest, Fixture, and Runtime Action Primitives - Validation Scenarios

### Scenario 2.1: Host-only hermetic scripts run without product manifests [STATUS: pending]
**Type**: Happy Path

**Given**: Gateway drift, gateway health honest, OpenShell version pin, docs validation, or Ollama auth proxy host-only scenarios declare explicit no-manifest reasons.
**When**: Scenario resolution and preview run.
**Then**: The resolved contract includes environment, fixtures, runtime actions if needed, real assertions, and no fake `NemoClawInstance` manifest.

**Validation Steps**:
1. **Setup**: Bash: select host-only scenario contracts.
2. **Execute**: `npx vitest run test/e2e/scenario-framework-tests`.
3. **Verify**: Vitest/report: no-manifest reason is present and scenario is not blocked by missing product manifest.

**Tools Required**: Bash, Vitest.

### Scenario 2.2: Dangerous fixtures cannot omit cleanup [STATUS: pending]
**Type**: Sad Path

**Given**: A fixture mutates Docker daemon config, `/etc/hosts`, policies, blueprint files, or images.
**When**: Fixture validation runs.
**Then**: Validation fails unless cleanup/restore obligations and tests are declared.

**Validation Steps**:
1. **Setup**: Bash: create mutation fixture metadata with cleanup omitted.
2. **Execute**: Vitest: run fixture validation.
3. **Verify**: Vitest: failure names mutation type and missing cleanup obligation.

**Tools Required**: Bash, Vitest.

### Scenario 2.3: Runtime action evidence preserves declared order [STATUS: pending]
**Type**: Happy Path

**Given**: A scenario declares ordered runtime actions such as `channels.add`, `inference.set`, `snapshot.create`, and `rebuild`.
**When**: The runtime action runner creates a plan or executes hermetically.
**Then**: Evidence records appear in declaration order and assertions can reference action outputs.

**Validation Steps**:
1. **Setup**: Bash: select scenario with multiple runtime actions.
2. **Execute**: Vitest: run runtime action planner/runner tests.
3. **Verify**: Vitest: assert evidence ordering and output dependency resolution.

**Tools Required**: Bash, Vitest.

## Phase 3: Onboarding and Installer Parity - Validation Scenarios

### Scenario 3.1: Cloud OpenClaw onboarding maps only with all three inference surfaces [STATUS: pending]
**Type**: Happy Path

**Given**: A live or hermetic OpenClaw cloud onboarding scenario completes onboarding.
**When**: Direct provider chat, sandbox `inference.local` chat, and OpenClaw-mediated agent response assertions all run.
**Then**: The onboarding behavior can be marked `mapped-live` or `mapped-hermetic` with distinct evidence paths for each surface.

**Validation Steps**:
1. **Setup**: Scenario runner: provision required OpenClaw cloud onboarding contract with declared secrets or hermetic fake provider.
2. **Execute**: Scenario runner/Vitest: run the three inference assertion modules.
3. **Verify**: Report: all three assertion IDs have evidence and parity status is mapped only after all pass.

**Tools Required**: Scenario runner, Bash, Vitest, optional live provider secret.

### Scenario 3.2: Negative onboarding leaves no forbidden side effects [STATUS: pending]
**Type**: Sad Path

**Given**: Invalid NVIDIA key or gateway port conflict fixtures are injected by scenario setup, not product manifests.
**When**: Onboarding is executed.
**Then**: It exits with the expected message, no stack trace, and no sandbox/gateway/credential side effects.

**Validation Steps**:
1. **Setup**: Scenario runner: stage bad-key or port-holder fixture.
2. **Execute**: Bash: run onboarding action.
3. **Verify**: Bash/Vitest: inspect logs and state paths for expected message and absence of forbidden side effects.

**Tools Required**: Bash, Scenario runner, Vitest.

### Scenario 3.3: Public installer and launchable flows are not satisfied by repo-current [STATUS: pending]
**Type**: Sad Path

**Given**: A public-curl, launchable, Spark, or installer scenario is wired to a repo-current install manifest.
**When**: Contract validation runs.
**Then**: Validation fails and asks for explicit install source/ref/log evidence or setup-only scenario.

**Validation Steps**:
1. **Setup**: Bash: create invalid install-source metadata fixture.
2. **Execute**: Vitest: run manifest/contract validation.
3. **Verify**: Vitest: assert repo-current substitution is rejected.

**Tools Required**: Bash, Vitest.

## Phase 4: Inference Provider, Routing, and Config-Shape Parity - Validation Scenarios

### Scenario 4.1: Bedrock-compatible parity covers adapter, configs, runtime, traffic, and leaks [STATUS: pending]
**Type**: Happy Path

**Given**: Bedrock-compatible Anthropic fake endpoint, host mapping, adapter token, and OpenClaw/Hermes scenario contracts are available.
**When**: Onboarding and runtime assertions execute.
**Then**: Health, registry, config shape, sandbox route chat, agent runtime chat, authenticated Converse/ConverseStream traffic, safe logs, and leak scans all pass.

**Validation Steps**:
1. **Setup**: Scenario runner: start fake Bedrock endpoint and host mapping fixture.
2. **Execute**: Scenario runner/Bash: run onboarding and Bedrock assertion modules.
3. **Verify**: Evidence report: each required assertion ID is present with no secret leak findings.

**Tools Required**: Bash, Scenario runner, Vitest, Docker optional.

### Scenario 4.2: Generic `/v1/models` health cannot satisfy provider-specific routing [STATUS: pending]
**Type**: Sad Path

**Given**: Kimi, model-router, inference-switch, or runtime-overrides parity entry has only a generic models-health assertion.
**When**: Parity validation runs.
**Then**: The entry remains `partial` and mapped status is rejected.

**Validation Steps**:
1. **Setup**: Bash: select or inject provider-specific contract with only generic health assertion.
2. **Execute**: Vitest: run parity validation.
3. **Verify**: Vitest/report: status is `partial` and reason names missing provider/config/trajectory assertions.

**Tools Required**: Bash, Vitest.

### Scenario 4.3: Inference switch proves state, config hash, and live post-switch request [STATUS: pending]
**Type**: Happy Path

**Given**: OpenClaw or Hermes inference switch action is declared.
**When**: The action runs and assertions inspect route state, registry/session state, config hash/shape, and live post-switch request.
**Then**: Switch parity is mapped only if all surfaces match expected values and no unwanted restart occurred where legacy checked it.

**Validation Steps**:
1. **Setup**: Scenario runner: provision switchable provider fixtures.
2. **Execute**: Scenario runner/Bash: run `inference.set` and assertion modules.
3. **Verify**: Evidence report: route/session/registry/config/live request assertion IDs all pass.

**Tools Required**: Bash, Scenario runner, Vitest.

## Phase 5: Local GPU and Ollama Parity - Validation Scenarios

### Scenario 5.1: GPU/Ollama full path proves GPU markers and repeated sandbox inference [STATUS: pending]
**Type**: Happy Path

**Given**: GPU runner contract declares Docker CDI, `nvidia-smi`, Ollama install/start/model-pull, and sandbox setup.
**When**: The local Ollama OpenClaw scenario runs initial and repeated onboarding.
**Then**: Sandbox status reports GPU enabled, install logs contain GPU proof markers, host API is reachable, and sandbox `inference.local` returns expected content after each onboarding.

**Validation Steps**:
1. **Setup**: Scenario runner on GPU runner: install/start Ollama and pull model.
2. **Execute**: Scenario runner: run onboarding and repeated inference assertions.
3. **Verify**: Bash/report: GPU markers, status, host API, and sandbox chat evidence are present.

**Tools Required**: GPU runner, Docker CDI, Ollama, Bash, Scenario runner.

### Scenario 5.2: Ollama auth proxy rejects bad tokens and preserves persisted token [STATUS: pending]
**Type**: Happy Path

**Given**: Host-only Ollama auth proxy fixture starts with a persisted token file.
**When**: Requests are made with no token, wrong token, and valid token, then the proxy restarts.
**Then**: Unauthenticated/wrong-token requests fail, valid-token requests pass, token file has `600` permissions, and restart keeps token stable.

**Validation Steps**:
1. **Setup**: Bash: start auth proxy fixture and record token path.
2. **Execute**: curl/Bash: issue unauthorized, wrong-token, valid-token, and post-restart requests.
3. **Verify**: Bash: assert status codes, file permissions, and token equality.

**Tools Required**: Bash, curl, Ollama/proxy fixture.

### Scenario 5.3: Cloud inference cannot claim local Ollama parity [STATUS: pending]
**Type**: Sad Path

**Given**: A local Ollama parity entry references cloud inference assertions only.
**When**: Parity validation runs.
**Then**: The entry is rejected or remains `partial` with missing Ollama/GPU/proxy-specific assertions listed.

**Validation Steps**:
1. **Setup**: Bash: inject invalid mapping from cloud inference to Ollama parity.
2. **Execute**: Vitest: run parity validation.
3. **Verify**: Vitest: assert mapped status is rejected.

**Tools Required**: Bash, Vitest.

## Phase 6: Messaging Channel Lifecycle Parity - Validation Scenarios

### Scenario 6.1: Multi-channel manifest and lifecycle actions map channel add/remove/stop/start [STATUS: pending]
**Type**: Happy Path

**Given**: Product manifests use `channels: []` or arrays such as `[telegram, discord, slack, wechat, whatsapp]`.
**When**: Channel add/remove/stop/start and rebuild runtime actions execute.
**Then**: Command output, policy preset state, agent config, provider records, egress probes, registry/cache state, and rebuild effects match expectations.

**Validation Steps**:
1. **Setup**: Scenario runner: provision fake channel token/id fixtures.
2. **Execute**: Scenario runner/Bash: run channel lifecycle actions.
3. **Verify**: Assertion modules: inspect command output, config, registry, provider cache, egress, and rebuild evidence.

**Tools Required**: Bash, Scenario runner, Vitest.

### Scenario 6.2: Single-provider checks cannot satisfy full messaging matrix [STATUS: pending]
**Type**: Sad Path

**Given**: Full messaging matrix parity is claimed using one provider check.
**When**: Parity validation runs.
**Then**: Validation rejects mapped status and lists missing channel/provider/agent combinations.

**Validation Steps**:
1. **Setup**: Bash: inject single-provider matrix claim.
2. **Execute**: Vitest: run parity validation.
3. **Verify**: Vitest/report: mapped status rejected with missing matrix rows.

**Tools Required**: Bash, Vitest.

### Scenario 6.3: Token rotation isolates changed provider and same-token reuse is no-op [STATUS: pending]
**Type**: Happy Path

**Given**: Token A/B fixtures and provider cache/state reader are available.
**When**: A provider token changes, then the same token is submitted again.
**Then**: Only the changed provider rebuilds, credential hashes update, and same-token reuse does not rebuild.

**Validation Steps**:
1. **Setup**: Scenario runner: stage token A/B fixtures.
2. **Execute**: Scenario runner/Bash: run token rotation actions.
3. **Verify**: Assertion modules: inspect hashes, changed-provider rebuild evidence, and no-op evidence.

**Tools Required**: Bash, Scenario runner, Vitest.

## Phase 7: Messaging Deep Agent Flow Parity - Validation Scenarios

### Scenario 7.1: Hermes Discord/Slack flow observes credential rewrite through fake gateway/API [STATUS: pending]
**Type**: Happy Path

**Given**: Hermes Discord or Slack scenario uses fake gateway/API and native WebSocket credential rewrite fixture.
**When**: Hermes starts with the channel enabled.
**Then**: Health, config, `.env` placeholder shape, provider records, scoped policy, fake gateway token capture, and raw-token absence across config/env/proc/files/logs all pass.

**Validation Steps**:
1. **Setup**: Scenario runner: start fake Discord Gateway or Slack REST/WebSocket fixture.
2. **Execute**: Scenario runner/Bash: start Hermes channel flow.
3. **Verify**: Assertion modules: inspect config, provider state, gateway captures, policy, and leak scans.

**Tools Required**: Bash, Scenario runner, Vitest.

### Scenario 7.2: Pairing path fails if allowlist is preconfigured [STATUS: pending]
**Type**: Sad Path

**Given**: OpenClaw Discord/Slack pairing parity is claimed while `allowFrom` is preconfigured.
**When**: Pairing validation runs.
**Then**: Validation rejects the mapping because the pending/approval path was bypassed.

**Validation Steps**:
1. **Setup**: Bash: inject pairing scenario with preconfigured allowlist.
2. **Execute**: Vitest: run pairing contract validation.
3. **Verify**: Vitest: assert mapped status fails with bypass reason.

**Tools Required**: Bash, Vitest.

### Scenario 7.3: Pairing approval consumes code and second approval fails closed [STATUS: pending]
**Type**: Happy Path

**Given**: Pairing request creation fixture and connect-shell approval action are available with no initial allowlist.
**When**: Approval is executed once and then repeated with the same code.
**Then**: First approval consumes code and updates `allowFrom`; second approval fails closed.

**Validation Steps**:
1. **Setup**: Scenario runner: create pairing request and pending file.
2. **Execute**: Bash: run approval action twice.
3. **Verify**: Assertion modules: inspect pending file, `allowFrom`, and second failure evidence.

**Tools Required**: Bash, Scenario runner, Vitest.

## Phase 8: Credentials, Security Policy, and Shields Parity - Validation Scenarios

### Scenario 8.1: Credential migration removes plaintext and preserves symlink victim [STATUS: pending]
**Type**: Happy Path

**Given**: Legacy credentials fixture includes allowlisted keys, malicious keys, and a symlink victim.
**When**: Migration runs.
**Then**: Migration notice is emitted, legacy plaintext is removed safely, tampered keys do not become providers, gateway-backed credentials list works, no plaintext file is recreated, and symlink victim remains intact.

**Validation Steps**:
1. **Setup**: Scenario runner: stage legacy credentials and symlink victim.
2. **Execute**: Bash: run migration/onboarding path.
3. **Verify**: Bash/assertions: inspect notice, provider state, file absence, credential list, and victim content.

**Tools Required**: Bash, Scenario runner, Vitest.

### Scenario 8.2: Single policy-present check remains partial for network policy parity [STATUS: pending]
**Type**: Sad Path

**Given**: Network policy parity is claimed using only a preset-present assertion.
**When**: Parity validation runs.
**Then**: The entry remains `partial` until deny-by-default, preset adds, dry-run no-op, Jira binary scope, inference exemption, hot reload, permissive mode, and SSRF validation are asserted.

**Validation Steps**:
1. **Setup**: Bash: inject weak policy parity claim.
2. **Execute**: Vitest: run parity validation.
3. **Verify**: Vitest/report: mapped status rejected and missing policy behaviors listed.

**Tools Required**: Bash, Vitest.

### Scenario 8.3: Shields lifecycle validates up/down/audit/auto-restore and secret redaction [STATUS: pending]
**Type**: Happy Path

**Given**: Shields scenario declares up/down actions and audit reset fixture.
**When**: Shields up/down commands and auto-restore behavior run.
**Then**: File mode/owner transitions, config redaction, audit JSON validity/no secrets, auto-restore, and double-command rejection all pass.

**Validation Steps**:
1. **Setup**: Scenario runner: provision shields fixture and audit reset.
2. **Execute**: Bash: run shields up/down and recovery actions.
3. **Verify**: Assertion modules: inspect file metadata, redacted config, audit JSON, recovery, and double-command failure evidence.

**Tools Required**: Bash, Scenario runner, Vitest.

## Phase 9: Sandbox Lifecycle, State, Backup, Snapshot, and Skill Parity - Validation Scenarios

### Scenario 9.1: Sandbox operations prove multi-sandbox isolation and recovery [STATUS: pending]
**Type**: Happy Path

**Given**: Two sandboxes, alternate dashboard URL fixture, registry deletion fixture, and gateway process/container kill action are available.
**When**: List/status/logs/chat, registry rebuild, gateway recovery, SSH recovery, and isolation assertions run.
**Then**: Both sandboxes remain isolated and recoverable with correct metadata.

**Validation Steps**:
1. **Setup**: Scenario runner: create two sandboxes and stage registry deletion/kill actions.
2. **Execute**: Bash: run lifecycle operations and recovery actions.
3. **Verify**: Assertion modules: inspect list/status/logs/chat, registry rebuild, gateway/SSH recovery, and isolation evidence.

**Tools Required**: Bash, Scenario runner, Docker/OpenShell.

### Scenario 9.2: Snapshot latest-only restore cannot claim snapshot parity [STATUS: pending]
**Type**: Sad Path

**Given**: Snapshot parity has create/list/latest restore only.
**When**: Parity validation runs.
**Then**: The entry remains `partial` until targeted timestamp restore and sanitization assertions exist.

**Validation Steps**:
1. **Setup**: Bash: inject snapshot parity without timestamp restore.
2. **Execute**: Vitest: run parity validation.
3. **Verify**: Vitest/report: mapped status rejected.

**Tools Required**: Bash, Vitest.

### Scenario 9.3: Backup/restore destroys, recreates, and restores identity/memory files [STATUS: pending]
**Type**: Happy Path

**Given**: Workspace, agent, nested marker fixtures and backup/destroy/recreate/restore actions are available.
**When**: Backup, destroy, recreate, and restore run.
**Then**: Exact identity and memory files are restored with sanitization evidence.

**Validation Steps**:
1. **Setup**: Scenario runner: stage workspace and identity/memory markers.
2. **Execute**: Bash: run backup/destroy/recreate/restore actions.
3. **Verify**: Assertion modules: compare restored file content and sanitization evidence.

**Tools Required**: Bash, Scenario runner, Docker/OpenShell.

## Phase 10: Rebuild, Upgrade, Installer Version, and Runtime Edge Parity - Validation Scenarios

### Scenario 10.1: Rebuild/upgrade starts from old sandbox/image fixtures [STATUS: pending]
**Type**: Happy Path

**Given**: Old OpenClaw/Hermes images, old registry/session state, and temporary blueprint min-version mutation with restore are staged.
**When**: Rebuild or upgrade actions run.
**Then**: Markers, policies, messaging config, backup sanitization, agent version change, stale-before/up-to-date-after checks, and survivor reachability all pass.

**Validation Steps**:
1. **Setup**: Scenario runner: stage old image/registry/session/blueprint fixtures.
2. **Execute**: Bash: run rebuild/upgrade actions.
3. **Verify**: Assertion modules: inspect markers, policy, messaging, backups, versions, stale/up-to-date, and reachability evidence.

**Tools Required**: Bash, Scenario runner, Docker/OpenShell.

### Scenario 10.2: Fresh sandbox rebuild remains partial [STATUS: pending]
**Type**: Sad Path

**Given**: Rebuild parity is claimed from a fresh sandbox without old-sandbox fixture.
**When**: Parity validation runs.
**Then**: The entry remains `partial` and missing old-sandbox fixture is reported.

**Validation Steps**:
1. **Setup**: Bash: inject fresh-only rebuild parity claim.
2. **Execute**: Vitest: run parity validation.
3. **Verify**: Vitest/report: mapped status rejected.

**Tools Required**: Bash, Vitest.

### Scenario 10.3: Installer-only and runtime edge scenarios stay hermetic/setup-specific [STATUS: pending]
**Type**: Happy Path

**Given**: OpenShell version pin, overlayfs autofix, and EXDEV runtime dependency replacement contracts are setup/hermetic with required fixtures.
**When**: Contract validation and hermetic assertions run.
**Then**: Version pin replacement, overlayfs patched-image create/reuse plus opt-out negative path, and EXDEV repro source/destination behavior pass without requiring product manifests.

**Validation Steps**:
1. **Setup**: Scenario runner/Bash: stage installer asset, Docker daemon mutation backup, patched image, policy mutation, and EXDEV fixtures.
2. **Execute**: Bash/Vitest: run hermetic assertions.
3. **Verify**: Assertion modules: inspect version replacement, overlayfs behavior, opt-out negative, EXDEV fix evidence, and cleanup restore evidence.

**Tools Required**: Bash, Vitest, Docker optional.

## Phase 11: Gateway, Dashboard, Device Auth, Crash Loop, Tunnel, and Remote Service Parity - Validation Scenarios

### Scenario 11.1: Gateway/dashboard/device-auth assertions check exact legacy boundaries [STATUS: pending]
**Type**: Happy Path

**Given**: Dashboard bind env, device-auth probes, and gateway health honest fixtures are available.
**When**: Assertions run.
**Then**: Dashboard forward binds all interfaces, `/health=200` and root `401` are treated correctly, status is not offline, crash shim is not reported healthy, and drift preflight fails closed without unsafe sandbox list.

**Validation Steps**:
1. **Setup**: Scenario runner: stage dashboard/device-auth/gateway drift fixtures.
2. **Execute**: Bash: run probes and assertions.
3. **Verify**: Assertion modules: inspect bind table, HTTP statuses, status output, crash shim result, and drift preflight call evidence.

**Tools Required**: Bash, curl, Scenario runner, Vitest.

### Scenario 11.2: Generic gateway health cannot satisfy health-honest or crash-loop parity [STATUS: pending]
**Type**: Sad Path

**Given**: Gateway health or crash-loop parity is claimed with only a single generic `/health` probe.
**When**: Parity validation runs.
**Then**: The claim remains `partial` and missing crash shim, orphan cleanup, repeated kill/recovery, guard-chain, and soak checks are listed.

**Validation Steps**:
1. **Setup**: Bash: inject weak gateway parity claim.
2. **Execute**: Vitest: run parity validation.
3. **Verify**: Vitest/report: mapped status rejected with missing behaviors.

**Tools Required**: Bash, Vitest.

### Scenario 11.3: Tunnel lifecycle distinguishes Cloudflare transient skips from NemoClaw faults [STATUS: pending]
**Type**: Happy Path

**Given**: `cloudflared` install/classifier fixture and tunnel start/stop runtime actions are declared.
**When**: Tunnel starts, status is inspected, dashboard is served, and tunnel stops.
**Then**: URL appears in status, serves OpenClaw dashboard, disappears after stop, and failures are classified as Cloudflare transient or NemoClaw fault.

**Validation Steps**:
1. **Setup**: Scenario runner: install or locate `cloudflared` and classifier fixture.
2. **Execute**: Bash: run tunnel start/status/probe/stop.
3. **Verify**: Assertion modules: inspect status URL, dashboard response, stop result, and classifier output.

**Tools Required**: Bash, curl, cloudflared, Scenario runner.

### Scenario 11.4: TUI/chat correlation runs against live gateway websocket [STATUS: pending]
**Type**: Happy Path

**Given**: A live gateway websocket is available and the Vitest live wrapper is configured.
**When**: TUI/chat correlation test runs.
**Then**: The test passes against the live gateway and static artifacts alone cannot satisfy the parity entry.

**Validation Steps**:
1. **Setup**: Scenario runner: start sandbox/gateway and export websocket context.
2. **Execute**: `npx vitest run test/openclaw-tui-chat-correlation.test.ts` or scenario wrapper.
3. **Verify**: Vitest/report: live websocket evidence is attached to the assertion ID.

**Tools Required**: Bash, Vitest, live gateway.

## Phase 12: Clean the House - Validation Scenarios

### Scenario 12.1: Final inventory has no completed metadata-only or ownerless partial entries [STATUS: pending]
**Type**: Happy Path

**Given**: Final parity inventory/report is generated.
**When**: Final hygiene validation runs.
**Then**: No `metadata-only` entry is presented as complete parity, every `partial` has owner/follow-up, and completed entries are mapped or retired with rationale.

**Validation Steps**:
1. **Setup**: Bash: generate final parity inventory/report.
2. **Execute**: Vitest: run final hygiene tests.
3. **Verify**: Vitest/report: no completed metadata-only entries and no ownerless partial entries.

**Tools Required**: Bash, Vitest.

### Scenario 12.2: Placeholder assertion groups are removed or explicitly retired [STATUS: pending]
**Type**: Sad Path

**Given**: A placeholder/no-op assertion group remains and is marked complete.
**When**: Final hygiene validation runs.
**Then**: Validation fails until the placeholder is removed, replaced by a real module, or retired with rationale.

**Validation Steps**:
1. **Setup**: Bash: leave or inject placeholder assertion group in final metadata.
2. **Execute**: Vitest: run final hygiene tests.
3. **Verify**: Vitest: failure names the placeholder group and required remediation.

**Tools Required**: Bash, Vitest.

### Scenario 12.3: Docs and deterministic reports are updated without deleting legacy scripts [STATUS: pending]
**Type**: Happy Path

**Given**: Implementation is complete and legacy scripts remain in place.
**When**: Docs and reports are checked.
**Then**: `test/e2e/docs/README.md` and `test/e2e/docs/MIGRATION.md` document contract model/status vocabulary/final wave status, generated reports are deterministic, and legacy script retirement candidates are listed but scripts are not deleted.

**Validation Steps**:
1. **Setup**: Bash: render reports twice and list legacy `test/e2e/test-*.sh` scripts.
2. **Execute**: Bash/Vitest: compare report outputs and run docs hygiene tests.
3. **Verify**: Bash/Vitest: docs contain required sections, reports are byte-identical, and legacy scripts still exist.

**Tools Required**: Bash, Vitest.

## Summary

| Phase | Happy | Sad | Total | Passed | Failed | Pending |
|-------|-------|-----|-------|--------|--------|---------|
| Phase 1 | 1 | 2 | 3 | 0 | 0 | 3 |
| Phase 2 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 3 | 1 | 2 | 3 | 0 | 0 | 3 |
| Phase 4 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 5 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 6 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 7 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 8 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 9 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 10 | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 11 | 3 | 1 | 4 | 0 | 0 | 4 |
| Phase 12 | 2 | 1 | 3 | 0 | 0 | 3 |
| **Total** | **23** | **14** | **37** | **0** | **0** | **37** |
