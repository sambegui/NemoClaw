#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared platform/remote E2E domain primitives. Suite steps source this
# library and consume the normalized context emitted by run-scenario.sh.

_PLATFORM_REMOTE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_ROOT="$(cd "${_PLATFORM_REMOTE_LIB_DIR}/../.." && pwd)"

# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_ROOT}/runtime/lib/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_ROOT}/runtime/lib/context.sh"
# shellcheck source=../sandbox-exec.sh
. "${_PLATFORM_REMOTE_LIB_DIR}/../sandbox-exec.sh"

e2e_platform_remote_load_context() {
  e2e_context_require E2E_SCENARIO
}

e2e_platform_remote_require_context_keys() {
  e2e_context_require "$@"
}

e2e_platform_remote_redact() {
  sed -E \
    -e 's/nvapi-[A-Za-z0-9._-]+/[REDACTED]/g' \
    -e 's/(BREV_API_TOKEN|Brev token|brev[_ -]?token|token|proxy)[=:][^[:space:]]+/\1=[REDACTED]/Ig' \
    -e 's/(API_KEY|SECRET|PASSWORD|TOKEN)[=:][^[:space:]]+/\1=[REDACTED]/Ig' \
    -e 's/(brev-secret|proxy-secret|super-secret-test-token)/[REDACTED]/g'
}

e2e_platform_remote_assertion() {
  local assertion_id="${1:?assertion id required}"
  local detail="${2:-ok}"
  if e2e_env_is_dry_run; then
    e2e_pass "${assertion_id} dry-run ${detail}"
    return 0
  fi
  e2e_pass "${assertion_id} ${detail}"
}

e2e_platform_remote_skip() {
  local assertion_id="${1:?assertion id required}"
  local reason="${2:-skipped}"
  printf 'SKIP: %s %s\n' "${assertion_id}" "${reason}"
}

e2e_platform_remote_require_secret_metadata() {
  local secret_name="${1:?secret name required}"
  local assertion_id="${2:-expected.platform_remote.secret.${secret_name}}"
  if [[ -n "${!secret_name:-}" ]]; then
    e2e_platform_remote_assertion "${assertion_id}" "secret metadata present for ${secret_name}"
  else
    e2e_platform_remote_skip "${assertion_id}" "missing required secret metadata ${secret_name}"
  fi
}

# Thin prerequisite guards. Live checks are intentionally small; dry-run emits
# assertion IDs without probing host state.
e2e_platform_remote_require_docker() {
  local assertion_id="${1:-expected.platform_remote.prereq.docker-running}"
  if e2e_env_is_dry_run; then e2e_platform_remote_assertion "${assertion_id}"; return 0; fi
  docker info >/dev/null 2>&1 || e2e_fail "${assertion_id} docker daemon not running"
  e2e_pass "${assertion_id}"
}

e2e_platform_remote_require_linux() {
  local assertion_id="${1:-expected.platform_remote.prereq.linux}"
  [[ "$(uname -s)" == "Linux" ]] || { e2e_platform_remote_skip "${assertion_id}" "requires Linux"; return 0; }
  e2e_platform_remote_assertion "${assertion_id}"
}

e2e_platform_remote_require_macos() {
  local assertion_id="${1:-expected.platform_remote.prereq.macos}"
  [[ "$(uname -s)" == "Darwin" ]] || { e2e_platform_remote_skip "${assertion_id}" "requires macOS"; return 0; }
  e2e_platform_remote_assertion "${assertion_id}"
}

e2e_platform_remote_require_gpu() {
  local assertion_id="${1:-expected.platform_remote.prereq.nvidia-smi-vram}"
  if e2e_env_is_dry_run; then e2e_platform_remote_assertion "${assertion_id}"; return 0; fi
  nvidia-smi >/dev/null 2>&1 || e2e_fail "${assertion_id} nvidia-smi unavailable"
  e2e_pass "${assertion_id}"
}
