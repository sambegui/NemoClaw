---
title:
  page: "Testing and Coverage Priorities"
  nav: "Testing and Coverage"
description:
  main: "Contributor guidance for prioritizing behavior-focused tests and interpreting coverage reports in NemoClaw."
keywords: ["nemoclaw testing", "nemoclaw coverage", "behavior coverage", "cli tests"]
topics: ["ai_agents", "developer_tools"]
tags: ["testing", "coverage", "contributing"]
content:
  type: reference
  difficulty: intermediate
  audience: ["developer", "maintainer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Testing and Coverage Priorities

NemoClaw uses coverage reports to find blind spots, but coverage percentage is not the goal by itself. The goal is confidence that important user-visible, security-sensitive, and failure-prone behavior will fail tests when it regresses.

Use this page when deciding what to test next or when reviewing a coverage-focused pull request.

## Principles

- Prefer behavior tests over line-count tests. A useful test should describe a behavior that matters to users, maintainers, or the security model.
- Treat coverage reports as a risk map. Low coverage is a prompt to ask which behavior is missing, not a requirement to touch every branch.
- Keep the compiled CLI coverage ratchet as a regression floor. Do not write low-value tests only to move the dist-based percentage.
- Prefer source imports for new pure unit tests unless the test specifically validates compiled or published behavior.
- Keep subprocess tests for real CLI contracts. Use direct module tests for decision logic, parsing, and error branches.
- Security-sensitive paths deserve negative tests: malformed input, missing files, corrupt state, unsafe paths, and credential leakage.

## Coverage reports

There are two useful CLI coverage views:

- The existing compiled coverage ratchet covers `bin/**/*.js` and `dist/lib/**/*.js`. It protects the published CLI surface from large regressions.
- The source coverage report covers `src/**/*.ts` and `bin/**/*.js`. It is informational and maps closer to files developers edit.

Run source coverage locally with:

```bash
npm run coverage:cli:src
```

Use the source report to identify behavior gaps. Keep the compiled coverage ratchet green, but do not optimize exclusively for it.

## Behavior checklist

The checklist below is intentionally organized by behavior area rather than file path. Expand it when adding or reviewing tests.

### Sandbox lifecycle

- [x] `status` handles no sandboxes.
- [x] `status` reports unhealthy gateway state.
- [x] `status` preserves registry entries on gateway transport errors.
- [x] `connect --probe-only` recovers gateway state without opening SSH.
- [x] `destroy` treats an already-missing sandbox as cleaned up.
- [x] `destroy` cleans up messaging providers and service state.
- [ ] `rebuild` covers failed base image refresh and rollback behavior.
- [ ] `rebuild` preserves policy and credential safety during config regeneration.
- [ ] lifecycle commands cover stale default sandbox repair across registry and session state.

### Inference routing and local runtimes

- [x] local inference health distinguishes up, down, and malformed responses.
- [x] vLLM install covers image pull, model download, fatal logs, and readiness failures.
- [x] Ollama proxy helpers cover token and route handling.
- [ ] Ollama proxy startup covers bind conflicts, child process failures, and stale proxy cleanup.
- [ ] vLLM and NIM runtime paths cover missing GPU/runtime dependencies and recovery guidance.
- [ ] inference route reapply covers mismatched provider, missing provider, and partial OpenShell failures.

### Policy and network access

- [x] built-in policy presets load without path traversal.
- [x] custom preset validation rejects malformed or unsafe definitions.
- [x] policy merge/remove covers legacy and versionless policy structures.
- [ ] policy mutation covers duplicate endpoints across built-in and custom presets.
- [ ] policy mutation covers dry-run output parity with mutating paths.
- [ ] policy errors provide actionable recovery hints without leaking local paths unnecessarily.

### Credentials and secret handling

- [x] credential sanitization strips provider secrets before backups or sandbox writes.
- [x] credential store handles oversized legacy files safely.
- [x] credential resolution avoids exposing secrets in command output.
- [ ] credential rotation covers partial provider failures and stale canonical keys.
- [ ] credential reset covers corrupt store files and permission failures.
- [ ] diagnostics and status output remain redacted under failure conditions.

### State persistence and recovery

- [x] onboard session state handles missing, corrupt, and completed sessions.
- [x] sandbox session helpers cover snapshot naming and safe tar extraction paths.
- [ ] sandbox registry covers stale default sandbox repair.
- [ ] sandbox registry covers concurrent or partial writes.
- [ ] gateway recovery covers missing metadata, wrong active gateway, and trust rotation guidance.

### Diagnostics and observability

- [x] debug tarball creation reports tar failures.
- [x] debug collection covers fake local command paths.
- [x] log following handles partial source failures.
- [ ] diagnostics cover redaction failure safeguards.
- [ ] diagnostics cover unavailable OpenShell and Docker binaries independently.
- [ ] health/status output covers mixed healthy/unhealthy component states.

### Shields and hardening

- [x] shields status covers default, locked, down, and corrupt states.
- [x] shields timer covers parsing, marker validation, restore success, and restore failure.
- [ ] shields mode transitions cover repeated lock/unlock operations.
- [ ] shield failures cover missing sandbox, malformed state, and OpenShell command failures.
- [ ] security hardening checks cover Docker capability and seccomp regressions.

### CLI contracts

- [x] public help and aliases stay stable for common commands.
- [x] JSON output remains parseable for inventory and status commands.
- [x] parser-owned flags reject malformed values before mutation.
- [ ] non-interactive mode covers every mutating command that may prompt.
- [ ] dry-run behavior covers every mutating policy, channel, host, and lifecycle command.
- [ ] deprecated aliases provide recovery guidance without changing semantics.

## Prioritizing new tests

When choosing between test gaps, prioritize in this order:

1. Security boundaries: credentials, policy, path safety, SSRF, redaction, and sandbox hardening.
2. Destructive operations: destroy, rebuild, uninstall, cleanup, and credential reset.
3. User-blocking recovery: gateway drift, stale registry, failed inference, and broken local runtimes.
4. CLI contracts: JSON output, help, aliases, non-interactive mode, and dry-run behavior.
5. Low-risk formatting and unreachable defensive branches.

## When low coverage is acceptable temporarily

Low coverage can be acceptable when a path is legacy glue, platform-specific, or too coupled to test meaningfully without refactoring. In that case, record the reason in the pull request and prefer a small refactor that exposes behavior-level seams before adding tests.

`src/lib/onboard.ts` is currently a known deferred hotspot. Treat it as a refactor-and-test project rather than a target for broad line-count tests.
