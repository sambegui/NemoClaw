#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenClaw TUI/WebChat correlation E2E for #3145.
#
# Installs NemoClaw with the default OpenClaw agent, verifies that the sandbox
# consumes the pinned OpenClaw version, switches the model route to match the
# Hermes inference-switch E2E default, then runs the live WebSocket chat
# correlation proof from test/openclaw-tui-chat-correlation.test.ts.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

strip_ansi() {
  python3 -c 'import re, sys; sys.stdout.write(re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read()))'
}

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-openclaw-tui-correlation}"
SWITCH_PROVIDER="${NEMOCLAW_SWITCH_PROVIDER:-nvidia-prod}"
SWITCH_MODEL="${NEMOCLAW_SWITCH_MODEL:-z-ai/glm-5.1}"
INSTALL_LOG="/tmp/nemoclaw-e2e-openclaw-tui-correlation-install.log"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${E2E_DIR}/lib/sandbox-teardown.sh"
# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${E2E_DIR}/lib/install-path-refresh.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

section "Phase 0: Pre-cleanup"
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "Pre-cleanup complete"

section "Phase 1: Prerequisites"
if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set"
else
  fail "NVIDIA_API_KEY not set or invalid"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ]; then
  pass "NEMOCLAW_NON_INTERACTIVE=1"
else
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
  pass "Third-party software acceptance is set"
else
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

section "Phase 2: Install and onboard OpenClaw"
cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"
export NEMOCLAW_AGENT=openclaw

info "Running install.sh --non-interactive for sandbox ${SANDBOX_NAME}..."
bash install.sh --non-interactive --yes-i-accept-third-party-software >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait "$install_pid"
install_exit=$?
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

nemoclaw_refresh_install_env
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nemoclaw_ensure_local_bin_on_path

if [ "$install_exit" -eq 0 ]; then
  pass "install.sh completed"
else
  fail "install.sh failed (exit ${install_exit})"
  tail -80 "$INSTALL_LOG" || true
  exit 1
fi

command -v nemoclaw >/dev/null 2>&1 || {
  fail "nemoclaw not found on PATH"
  exit 1
}
command -v openshell >/dev/null 2>&1 || {
  fail "openshell not found on PATH"
  exit 1
}
pass "nemoclaw and openshell are on PATH"

section "Phase 3: Verify OpenClaw runtime floor"
expected_openclaw_version="$(sed -nE 's/^expected_version:[[:space:]]*"([^"]+)".*/\1/p' agents/openclaw/manifest.yaml | head -1)"
actual_openclaw_version="$(openshell sandbox exec --name "$SANDBOX_NAME" -- openclaw --version 2>&1 || true)"
plain_openclaw_version="$(printf '%s' "$actual_openclaw_version" | strip_ansi)"
if [ -n "$expected_openclaw_version" ] && grep -Fq "$expected_openclaw_version" <<<"$plain_openclaw_version"; then
  pass "Sandbox uses OpenClaw ${expected_openclaw_version}"
else
  fail "Sandbox OpenClaw version mismatch; expected ${expected_openclaw_version:-unknown}, got: ${plain_openclaw_version:0:240}"
  exit 1
fi

section "Phase 4: Align model route with Hermes inference-switch E2E"
info "Switching ${SANDBOX_NAME} to ${SWITCH_PROVIDER} / ${SWITCH_MODEL}..."
switch_output="$(nemoclaw inference set --no-verify --provider "$SWITCH_PROVIDER" --model "$SWITCH_MODEL" --sandbox "$SANDBOX_NAME" 2>&1)"
switch_rc=$?
if [ "$switch_rc" -eq 0 ]; then
  pass "nemoclaw inference set completed"
else
  fail "nemoclaw inference set failed (exit ${switch_rc}): ${switch_output:0:500}"
  exit 1
fi

route_output="$(openshell inference get -g nemoclaw 2>&1 || openshell inference get 2>&1 || true)"
plain_route_output="$(printf '%s' "$route_output" | strip_ansi)"
if grep -Fq "Provider: ${SWITCH_PROVIDER}" <<<"$plain_route_output" \
  && grep -Fq "Model: ${SWITCH_MODEL}" <<<"$plain_route_output"; then
  pass "OpenShell route points at ${SWITCH_PROVIDER} / ${SWITCH_MODEL}"
else
  fail "OpenShell route did not switch to ${SWITCH_PROVIDER} / ${SWITCH_MODEL}: ${plain_route_output:0:400}"
  exit 1
fi

section "Phase 5: Live TUI/WebChat correlation proof"
info "Installing repository dev dependencies for Vitest..."
if ! npm ci --ignore-scripts --include=dev --no-audit --no-fund >>"$INSTALL_LOG" 2>&1; then
  echo "ERROR: Failed to install repository dev dependencies for Vitest."
  tail -80 "$INSTALL_LOG" || true
  exit 1
fi

NEMOCLAW_ISSUE_3145_LIVE=1 \
  NEMOCLAW_ISSUE_3145_SANDBOX="$SANDBOX_NAME" \
  npx vitest run test/openclaw-tui-chat-correlation.test.ts
correlation_rc=$?
if [ "$correlation_rc" -eq 0 ]; then
  pass "OpenClaw live chat correlation proof passed"
else
  fail "OpenClaw live chat correlation proof failed"
fi

section "Phase 6: Cleanup"
if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true

  registry_file="${HOME}/.nemoclaw/sandboxes.json"
  if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
    fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
  else
    pass "Sandbox ${SANDBOX_NAME} removed"
  fi
else
  skip "Sandbox ${SANDBOX_NAME} kept; removal check skipped"
fi

echo ""
echo "=============================================="
echo "  OpenClaw TUI chat correlation E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "=============================================="

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  OpenClaw TUI chat correlation E2E PASSED.\033[0m\n'
  exit 0
fi

printf '\n\033[1;31m  OpenClaw TUI chat correlation E2E FAILED.\033[0m\n'
exit 1
