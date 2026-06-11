#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Managed Deep Agents Code launcher for NemoClaw/OpenShell sandboxes.

set -euo pipefail

export HOME=/sandbox
export PATH="/usr/local/bin:${PATH}"
export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1
export DEEPAGENTS_CODE_AUTO_UPDATE=0
export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"

for arg in "$@"; do
  case "$arg" in
    --version | -V | --help | -h)
      exec /usr/local/bin/dcode.real "$@"
      ;;
  esac
done

if [ -n "${NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST:-}" ] \
  && [ -z "${DEEPAGENTS_CODE_SHELL_ALLOW_LIST:-}" ]; then
  export DEEPAGENTS_CODE_SHELL_ALLOW_LIST="${NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST}"
fi

has_arg() {
  local wanted="$1"
  shift
  for arg in "$@"; do
    [ "$arg" = "$wanted" ] && return 0
    case "$arg" in
      "${wanted}="*) return 0 ;;
    esac
  done
  return 1
}

extra_args=()
if ! has_arg "--sandbox" "$@"; then
  extra_args+=(--sandbox none)
fi
if ! has_arg "--no-mcp" "$@"; then
  extra_args+=(--no-mcp)
fi

exec /usr/local/bin/dcode.real "${extra_args[@]}" "$@"
