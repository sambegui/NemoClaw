<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Specification: Scenario E2E Parity Expansion

Generated from: `specs/2026-05-26_scenario-e2e-parity-expansion/spec.md`

## Test Strategy

Use TDD for each phase: add failing schema/resolver/report tests first, then add fixture/action/assertion implementation and metadata. Tests must prove semantic parity; preview, dry-run, placeholder probes, and metadata registration alone must never satisfy a mapped parity claim.

Primary test locations:

- `test/e2e/scenario-framework-tests/*.test.ts` for schema, resolver, report, inventory, and contract validation.
- `test/e2e/runtime/resolver/*.ts` unit coverage through Vitest tests.
- New `test/e2e/scenario-framework-tests/e2e-parity-contracts.test.ts` for no-cheat parity gates.
- New `test/e2e/scenario-framework-tests/e2e-fixtures-runtime-actions.test.ts` for fixture/action primitives.
- New domain tests as needed under `test/e2e/scenario-framework-tests/` for onboarding, inference, messaging, security, lifecycle, upgrade, and gateway parity metadata.
- Existing scenario framework files remain the integration points: `test/e2e/nemoclaw_scenarios/scenarios.yaml`, `test/e2e/nemoclaw_scenarios/expected-states.yaml`, `test/e2e/validation_suites/suites.yaml`, `test/e2e/validation_suites/assert/`, `test/e2e/runtime/resolver/`, `test/e2e/runtime/reports/`, and `test/e2e/docs/`.

Do not create tests around a parallel `test/e2e/scenarios/` tree unless the active framework has moved there first; tests should fail if contract metadata is split away from the current resolver inputs.

## Cross-Phase Tests Required Everywhere

1. `test_should_reject_mapped_parity_without_real_assertion_step`
   - **Input**: parity inventory entry with `status: mapped-live` and only preview metadata.
   - **Expected**: validation fails and names the legacy script/assertion.
   - **Covers**: no-cheat gate, boundary gate.

2. `test_should_reject_mapped_parity_without_setup_contract`
   - **Input**: mapped parity entry missing `environment`, `manifest`/no-manifest reason, fixtures, runtime actions, or assertions.
   - **Expected**: validation fails with missing contract part.
   - **Covers**: setup gate.

3. `test_should_require_evidence_path_and_stable_assertion_id`
   - **Input**: assertion without `assertionId` or `evidencePath`.
   - **Expected**: validation fails.
   - **Covers**: evidence gate.

4. `test_should_reject_raw_secret_like_values_in_manifests_reports_and_fixtures`
   - **Input**: manifest/report fixture containing raw API-token-like values.
   - **Expected**: validation fails and points to the offending field.
   - **Covers**: secret gate.

5. `test_should_require_cleanup_for_dangerous_fixtures`
   - **Input**: Docker daemon, `/etc/hosts`, policy, blueprint, or image mutation fixture without cleanup/restore.
   - **Expected**: validation fails.
   - **Covers**: cleanup gate.

6. `test_should_require_inventory_entry_for_every_in_scope_legacy_script`
   - **Input**: audit list plus current `test/e2e/test-*.sh` files.
   - **Expected**: validation fails if a script lacks a parity inventory row, owner, and status.
   - **Covers**: inventory completeness gate.

7. `test_should_keep_phase_incomplete_until_all_assigned_behaviors_are_mapped_or_retired`
   - **Input**: phase report with any `partial`, `metadata-only`, or `deferred` behavior.
   - **Expected**: phase completion is false and the report lists owner/follow-up.
   - **Covers**: phase completion gate.

8. `test_should_reject_pending_steps_todos_and_generic_health_as_completed_assertions`
   - **Input**: completed parity entry backed by `pendingStep(...)`, TODO/no-op probe, or generic health-only assertion where domain-specific checks are required.
   - **Expected**: mapped status is rejected.
   - **Covers**: executable assertion gate.

## Phase 1: Parity Contract Foundation - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-schema.test.ts`
  - Add contract top-level schema validation for `environment`, `manifest`, `fixtures`, `runtimeActions`, and `assertions`.
- `test/e2e/scenario-framework-tests/e2e-expected-failure.test.ts`
  - Add expected-failure classes: `invalid-nvidia-api-key`, `gateway-port-conflict`, `unreachable-compatible-endpoint`, `gateway-schema-drift`, `stale-gateway-image`, `gateway-start-crash`.
- `test/e2e/scenario-framework-tests/e2e-coverage-report.test.ts`
  - Add report assertions for setup parity vs assertion parity.

**New Tests to Create:**

1. `test_should_accept_only_supported_parity_statuses`
   - **Input**: statuses `mapped-live`, `mapped-hermetic`, `partial`, `metadata-only`, `retired`, `deferred`, and one invalid status.
   - **Expected**: supported statuses pass; invalid status fails.
   - **Covers**: parity status vocabulary.

2. `test_should_label_preview_only_contract_as_metadata_only`
   - **Input**: previewable contract with no real assertion implementation.
   - **Expected**: parity status resolves to `metadata-only` and does not count as complete parity.
   - **Covers**: preview cannot count as parity.

3. `test_should_require_retired_rationale`
   - **Input**: retired legacy assertion with and without rationale.
   - **Expected**: entry without rationale fails.
   - **Covers**: retired status rules.

4. `test_should_render_legacy_script_contract_coverage_report`
   - **Input**: sample legacy script inventory with mixed covered/missing contract parts.
   - **Expected**: report includes each script and separate columns for environment, manifest/no-manifest, fixtures, runtime actions, assertions, and status.
   - **Covers**: foundation reporting.

**Test Implementation Notes:**

- Keep tests hermetic by using `loadMetadataFromObjects` fixtures where possible.
- Do not require live Docker, cloud, GPU, or provider secrets in Phase 1 tests.

## Phase 2: Environment, Manifest, Fixture, and Runtime Action Primitives - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-resolver.test.ts`
  - Resolve host-only/setup-only scenarios without a fake `NemoClawInstance` manifest.
- `test/e2e/scenario-framework-tests/e2e-suite-runner.test.ts`
  - Include ordered runtime-action evidence in the execution plan.

**New Tests to Create:**

1. `test_should_start_and_teardown_fake_service_fixture_with_evidence`
   - **Input**: fake OpenAI-compatible service fixture.
   - **Expected**: setup evidence, endpoint output, and teardown evidence are recorded.
   - **Covers**: fake service lifecycle.

2. `test_should_stage_and_cleanup_home_state_fixture`
   - **Input**: `sandboxes.json`, `onboard-session.json`, legacy `credentials.json`, and provider records fixture.
   - **Expected**: staged files exist during test and are removed/restored after teardown.
   - **Covers**: state staging.

3. `test_should_run_runtime_actions_in_declared_order`
   - **Input**: ordered actions `channels.add`, `inference.set`, `snapshot.create`, `rebuild`.
   - **Expected**: evidence order matches declaration and downstream assertions can reference action outputs.
   - **Covers**: runtime action runner.

4. `test_should_represent_gateway_health_honest_and_drift_preflight_as_hermetic_contracts`
   - **Input**: contracts for `test-gateway-health-honest.sh` and `test-gateway-drift-preflight.sh`.
   - **Expected**: no product manifest required; real hermetic assertion step required.
   - **Covers**: setup-heavy scripts.

5. `test_should_require_restore_for_hosts_docker_blueprint_and_policy_mutations`
   - **Input**: dangerous fixtures with missing restore handler.
   - **Expected**: validation fails.
   - **Covers**: dangerous fixture cleanup.

## Phase 3: Onboarding and Installer Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add onboarding/install manifests and scenario contracts.
- `test/e2e/scenario-framework-tests/e2e-expected-failure.test.ts`
  - Assert invalid key and gateway port conflict failure shape.

**New Tests to Create:**

1. `test_should_require_distinct_direct_sandbox_and_agent_inference_assertions_for_cloud_openclaw`
   - **Input**: happy-path OpenClaw onboarding contract missing one inference surface.
   - **Expected**: cannot become `mapped-live` until direct provider, sandbox `inference.local`, and agent-mediated assertions exist.
   - **Covers**: OpenClaw cloud onboarding parity.

2. `test_should_keep_public_installer_and_launchable_separate_from_repo_current`
   - **Input**: public-curl or launchable scenario pointing at repo-current install manifest.
   - **Expected**: validation fails.
   - **Covers**: install source/ref correctness.

3. `test_should_assert_negative_onboarding_message_no_stack_trace_and_no_side_effects`
   - **Input**: invalid key and port-conflict negative contracts.
   - **Expected**: required failure message, no stack trace, no sandbox/gateway/credential side effects.
   - **Covers**: negative onboarding.

4. `test_should_require_resume_and_repair_state_fixtures`
   - **Input**: resume/repair contracts without interrupted session or missing sandbox fixture.
   - **Expected**: validation fails.
   - **Covers**: resume/repair parity.

## Phase 4: Inference Provider, Routing, and Config-Shape Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add Bedrock, Kimi, model-router, switch, and runtime-overrides contracts.
- `test/e2e/scenario-framework-tests/e2e-coverage-report.test.ts`
  - Flag generic route health as partial for provider-specific parity.

**New Tests to Create:**

1. `test_should_reject_generic_models_health_as_provider_routing_parity`
   - **Input**: provider-specific contract with only `/v1/models` health.
   - **Expected**: status remains `partial`.
   - **Covers**: no generic health substitution.

2. `test_should_require_bedrock_adapter_health_config_shape_runtime_and_leak_scan`
   - **Input**: Bedrock contract missing adapter health, config shape, runtime chat, traffic observation, or leak scan.
   - **Expected**: cannot become mapped.
   - **Covers**: Bedrock parity.

3. `test_should_require_kimi_tool_call_trajectory_assertions`
   - **Input**: Kimi contract without discrete `hostname`, `date`, `uptime` exec-call trajectory evidence.
   - **Expected**: status remains `partial`.
   - **Covers**: Kimi compatibility.

4. `test_should_require_inference_switch_state_registry_config_hash_and_live_request`
   - **Input**: switch contract missing any required assertion.
   - **Expected**: validation fails for mapped status.
   - **Covers**: OpenClaw/Hermes inference switch.

## Phase 5: Local GPU and Ollama Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add GPU/Ollama manifests and host-only auth proxy contract.

**New Tests to Create:**

1. `test_should_require_gpu_environment_contract_for_local_ollama_gpu`
   - **Input**: GPU scenario without Docker CDI and `nvidia-smi` requirements.
   - **Expected**: validation fails.
   - **Covers**: GPU runner environment.

2. `test_should_require_proxy_auth_token_file_permissions_and_restart_stability`
   - **Input**: Ollama auth proxy contract missing 401/403, valid token, `600` token file, or restart-stability assertion.
   - **Expected**: status remains incomplete.
   - **Covers**: auth proxy parity.

3. `test_should_keep_host_only_proxy_out_of_sandbox_manifest_requirement`
   - **Input**: host-only auth proxy contract.
   - **Expected**: explicit no-manifest reason is accepted.
   - **Covers**: host-only setup.

4. `test_should_require_reonboard_token_matches_live_proxy`
   - **Input**: re-onboard contract without divergent-token recovery evidence.
   - **Expected**: validation fails.
   - **Covers**: token divergence recovery.

## Phase 6: Messaging Channel Lifecycle Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-schema.test.ts`
  - Ensure manifests support `channels: []` and multi-channel arrays.
- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add channel lifecycle, all-channel, token rotation, and Telegram security contracts.

**New Tests to Create:**

1. `test_should_reject_single_messaging_scalar_manifest`
   - **Input**: product manifest using `messaging: telegram` instead of `channels: [telegram]`.
   - **Expected**: validation fails.
   - **Covers**: manifest shape.

2. `test_should_require_post_onboard_channel_actions_and_rebuild_effects`
   - **Input**: channel lifecycle contract with channel metadata but no add/remove/stop/start or rebuild actions.
   - **Expected**: cannot become mapped.
   - **Covers**: lifecycle parity.

3. `test_should_require_changed_provider_only_rebuild_and_same_token_noop`
   - **Input**: token rotation contract missing changed-provider isolation or same-token no-rebuild assertion.
   - **Expected**: validation fails.
   - **Covers**: token rotation.

4. `test_should_require_injection_payload_no_execute_and_no_api_key_leak`
   - **Input**: Telegram security contract missing side-effect proof cleanup or leak scan.
   - **Expected**: validation fails.
   - **Covers**: injection safety.

## Phase 7: Messaging Deep Agent Flow Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add Hermes Discord/Slack and OpenClaw pairing contracts.

**New Tests to Create:**

1. `test_should_require_hermes_specific_discord_and_slack_config_assertions`
   - **Input**: Hermes messaging contract covered only by OpenClaw assertions.
   - **Expected**: validation fails.
   - **Covers**: Hermes-specific parity.

2. `test_should_require_fake_gateway_token_capture_not_placeholder`
   - **Input**: fake Discord/Slack gateway fixture without captured host token evidence.
   - **Expected**: cannot become mapped.
   - **Covers**: WebSocket credential rewrite.

3. `test_should_require_pairing_path_without_preconfigured_allowlist`
   - **Input**: pairing contract with allowlist preconfigured.
   - **Expected**: validation fails because pairing path is bypassed.
   - **Covers**: pairing parity.

4. `test_should_require_raw_token_absent_from_config_env_proc_fs_and_logs`
   - **Input**: token leak scan with incomplete surfaces.
   - **Expected**: validation fails.
   - **Covers**: secret hygiene.

## Phase 8: Credentials, Security Policy, and Shields Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-expected-failure.test.ts`
  - Add policy and shields failure vocabulary where needed.
- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add credential migration/sanitization, network policy, and shields contracts.

**New Tests to Create:**

1. `test_should_keep_credential_migration_and_sanitization_as_separate_domains`
   - **Input**: one contract attempting to satisfy both domains with one generic leak check.
   - **Expected**: parity report marks one or both partial.
   - **Covers**: domain separation.

2. `test_should_require_symlink_safe_unlink_for_credential_migration`
   - **Input**: credential migration fixture without symlink victim preservation assertion.
   - **Expected**: validation fails.
   - **Covers**: symlink safety.

3. `test_should_require_full_network_policy_behavior_matrix`
   - **Input**: network policy contract with only policy-present check.
   - **Expected**: status remains partial.
   - **Covers**: deny, preset, dry-run, Jira scope, inference exemption, hot reload, permissive, SSRF.

4. `test_should_require_shields_up_down_audit_and_auto_restore`
   - **Input**: shields contract with status/config consistency only.
   - **Expected**: status remains partial.
   - **Covers**: shields lifecycle parity.

## Phase 9: Sandbox Lifecycle, State, Backup, Snapshot, and Skill Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add lifecycle, rebuild, survival, snapshot, backup/restore, and skill-agent contracts.

**New Tests to Create:**

1. `test_should_require_multi_sandbox_isolation_for_operations_parity`
   - **Input**: sandbox operations contract with one sandbox only.
   - **Expected**: cannot become mapped.
   - **Covers**: multi-sandbox operations.

2. `test_should_require_snapshot_timestamp_restore_and_sanitization`
   - **Input**: snapshot contract with create/list/latest restore only.
   - **Expected**: status remains partial.
   - **Covers**: snapshot parity.

3. `test_should_require_destroy_recreate_restore_for_state_backup`
   - **Input**: backup contract with backup capture only.
   - **Expected**: status remains partial.
   - **Covers**: backup/restore parity.

4. `test_should_classify_skill_agent_model_flake_only_after_fixture_presence_proven`
   - **Input**: skill-agent contract marking external flake before skill fixture is present.
   - **Expected**: validation fails.
   - **Covers**: skill-agent no-cheat validation.

## Phase 10: Rebuild, Upgrade, Installer Version, and Runtime Edge Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add old-image, upgrade, installer pin, overlayfs, and EXDEV contracts.

**New Tests to Create:**

1. `test_should_require_old_sandbox_fixture_for_rebuild_parity`
   - **Input**: rebuild contract using fresh sandbox only.
   - **Expected**: status remains partial.
   - **Covers**: rebuild parity.

2. `test_should_require_policy_preservation_in_registry_gateway_and_backup_manifest`
   - **Input**: policy preservation contract with only registry assertion.
   - **Expected**: validation fails.
   - **Covers**: policy preservation.

3. `test_should_keep_installer_only_version_pin_as_setup_hermetic`
   - **Input**: OpenShell version pin contract forced into product manifest.
   - **Expected**: validation fails; setup-only no-manifest contract passes.
   - **Covers**: installer-only parity.

4. `test_should_require_overlayfs_positive_reuse_and_opt_out_negative_paths`
   - **Input**: overlayfs contract missing patched-image reuse or opt-out behavior.
   - **Expected**: status remains partial.
   - **Covers**: overlayfs autofix.

5. `test_should_require_exdev_repro_source_destination_fixture`
   - **Input**: EXDEV contract with generic copy test only.
   - **Expected**: validation fails.
   - **Covers**: runtime dependency replacement.

## Phase 11: Gateway, Dashboard, Device Auth, Crash Loop, Tunnel, and Remote Service Parity - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-scenario-additional-families.test.ts`
  - Add dashboard, device auth, gateway health/drift, crash-loop, tunnel, and TUI/chat correlation contracts.

**New Tests to Create:**

1. `test_should_require_dashboard_forward_bind_all_interfaces`
   - **Input**: dashboard remote bind contract checking localhost only.
   - **Expected**: status remains partial.
   - **Covers**: remote bind parity.

2. `test_should_require_device_auth_root_401_health_200_and_status_not_offline`
   - **Input**: device auth contract with only `/health` success.
   - **Expected**: validation fails.
   - **Covers**: device auth health.

3. `test_should_reject_generic_gateway_health_for_health_honest_parity`
   - **Input**: gateway health honest contract with generic `/health` probe only.
   - **Expected**: status remains partial.
   - **Covers**: honest health.

4. `test_should_require_repeated_crash_recovery_and_guard_chain_checks`
   - **Input**: crash-loop contract with one kill/recovery probe.
   - **Expected**: cannot become mapped.
   - **Covers**: crash-loop parity.

5. `test_should_distinguish_tunnel_cloudflare_transient_skip_from_nemoclaw_fault`
   - **Input**: tunnel contract without classifier.
   - **Expected**: validation fails.
   - **Covers**: tunnel lifecycle.

6. `test_should_require_live_gateway_websocket_for_tui_chat_correlation`
   - **Input**: TUI/chat correlation contract with static artifact only.
   - **Expected**: status remains partial.
   - **Covers**: live Vitest wrapper.

## Phase 12: Clean the House - Test Guide

**Existing Tests to Modify:**

- `test/e2e/scenario-framework-tests/e2e-metadata-final-hygiene.test.ts`
  - Add final hygiene checks for placeholder retirement, deterministic reports, docs, and TODO cleanup.

**New Tests to Create:**

1. `test_should_fail_if_metadata_only_presented_as_complete_parity`
   - **Input**: final parity report containing completed metadata-only entry.
   - **Expected**: validation fails.
   - **Covers**: final no-cheat cleanup.

2. `test_should_require_partial_entries_to_have_owner_or_followup_issue`
   - **Input**: partial entry without owner/follow-up.
   - **Expected**: validation fails.
   - **Covers**: cleanup accountability.

3. `test_should_render_parity_inventory_deterministically`
   - **Input**: inventory data in shuffled order.
   - **Expected**: two renders are byte-identical and sorted.
   - **Covers**: deterministic generated reports.

4. `test_should_require_contract_docs_and_migration_guidance_updates`
   - **Input**: spec-complete tree without `test/e2e/docs/README.md` or `test/e2e/docs/MIGRATION.md` updates.
   - **Expected**: hygiene test fails.
   - **Covers**: docs cleanup.

5. `test_should_list_legacy_script_retirement_candidates_without_deleting_scripts`
   - **Input**: mapped/retired inventory with existing legacy scripts.
   - **Expected**: report lists candidates; test verifies scripts still exist unless a later explicit deletion task removes them.
   - **Covers**: non-goal enforcement.
