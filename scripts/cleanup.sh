#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw cleanup — tears down all NemoClaw resources on this host.
# Mirrors the teardown procedure documented in scripts/INSTALLER-README.md.
#
# Usage:
#   bash scripts/cleanup.sh           # standard teardown
#   bash scripts/cleanup.sh --all     # teardown + purge HuggingFace model cache
#   bash scripts/cleanup.sh --yes     # skip the confirmation prompt
#

# Intentionally no `-e`: a missing optional CLI (nemoclaw / openshell) must
# not stop us from completing the rest of the teardown. Failures of individual
# steps are logged but cleanup continues.
set -uo pipefail

C_RED=$'\033[0;31m'
C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[1;33m'
C_CYAN=$'\033[0;36m'
C_RESET=$'\033[0m'

info() { printf "%b[cleanup]%b %s\n" "${C_CYAN}" "${C_RESET}" "$*"; }
ok()   { printf "%b[cleanup]%b %b✓%b %s\n" "${C_CYAN}" "${C_RESET}" "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf "%b[cleanup]%b %s\n" "${C_YELLOW}" "${C_RESET}" "$*"; }
fail() { printf "%b[cleanup]%b %s\n" "${C_RED}" "${C_RESET}" "$*" >&2; }

PURGE_CACHE=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
NemoClaw cleanup — tears down all NemoClaw resources on this host.

Usage:
  bash scripts/cleanup.sh [--all] [--yes]

Options:
  --all       Also purge cached HuggingFace model weights
              (~/.cache/huggingface/hub/models--*).
  --yes, -y   Skip the confirmation prompt.
  -h, --help  Show this help.

Standard teardown (always):
  1. Stops every NemoClaw sandbox listed in ~/.nemoclaw/sandboxes.json.
  2. Destroys the OpenShell gateway named 'nemoclaw'.
  3. Stops and removes the 'nemoclaw-vllm' Docker container.
  4. Removes ~/.nemoclaw/onboard-session.json so the installer starts fresh.
  5. Verifies GPU memory has been released.

With --all, additionally:
  6. Deletes every ~/.cache/huggingface/hub/models--* directory (frees disk).
EOF
}

for arg in "$@"; do
  case "$arg" in
    --all)        PURGE_CACHE=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            fail "Unknown argument: $arg"; usage >&2; exit 2 ;;
  esac
done

# ── Confirmation ────────────────────────────────────────────────────────────
if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf "\n"
  printf "%bThis will tear down all NemoClaw sandboxes, the gateway, and the vLLM container.%b\n" "${C_YELLOW}" "${C_RESET}"
  if [[ "$PURGE_CACHE" -eq 1 ]]; then
    printf "%b--all: cached HuggingFace model weights will also be deleted.%b\n" "${C_RED}" "${C_RESET}"
  fi
  printf "Continue? [y/N]: "
  read -r reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    info "Aborted."
    exit 0
  fi
fi

# ── 1. Stop all sandboxes ───────────────────────────────────────────────────
info "Stopping all NemoClaw sandboxes…"
sandboxes_file="${HOME}/.nemoclaw/sandboxes.json"
sandbox_names=""
if [[ -f "$sandboxes_file" ]] && command -v python3 >/dev/null 2>&1; then
  sandbox_names=$(python3 - "$sandboxes_file" <<'PY' || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("\n".join((d.get("sandboxes") or {}).keys()))
except Exception:
    pass
PY
)
fi

if [[ -n "$sandbox_names" ]]; then
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    info "  Stopping sandbox '${name}'…"
    if command -v nemoclaw >/dev/null 2>&1; then
      nemoclaw "$name" stop >/dev/null 2>&1 || warn "    nemoclaw ${name} stop failed (continuing)"
    else
      warn "    nemoclaw CLI not found — skipping stop for ${name}"
    fi
  done <<< "$sandbox_names"
  ok "Sandboxes stopped"
else
  info "  No sandboxes registered"
fi

# ── 2. Destroy OpenShell gateway ────────────────────────────────────────────
info "Destroying OpenShell gateway 'nemoclaw'…"
if command -v openshell >/dev/null 2>&1; then
  if openshell gateway destroy --name nemoclaw --force >/dev/null 2>&1; then
    ok "Gateway destroyed"
  else
    warn "Gateway destroy failed or gateway was not present (continuing)"
  fi
else
  warn "openshell not installed — skipping gateway destroy"
fi

# ── 3. Snapshot GPU VRAM before vLLM teardown ───────────────────────────────
gpu_idx=""
vram_before=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_row=$(nvidia-smi --query-gpu=index,memory.total --format=csv,noheader,nounits 2>/dev/null \
            | sort -t',' -k2 -rn | head -1 || true)
  gpu_idx=$(printf "%s" "$gpu_row" | awk -F',' '{print $1}' | tr -d ' ')
  if [[ -n "$gpu_idx" ]]; then
    vram_before=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits \
      -i "$gpu_idx" 2>/dev/null | tr -d ' ')
  fi
fi

# ── 4. Stop and remove vLLM container ───────────────────────────────────────
info "Stopping and removing 'nemoclaw-vllm' container…"
if command -v docker >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^nemoclaw-vllm$"; then
    docker stop nemoclaw-vllm >/dev/null 2>&1 || warn "  docker stop nemoclaw-vllm failed"
    docker rm   nemoclaw-vllm >/dev/null 2>&1 || warn "  docker rm nemoclaw-vllm failed"
    ok "vLLM container removed"
  else
    info "  No 'nemoclaw-vllm' container found"
  fi
else
  warn "docker not installed — skipping vLLM teardown"
fi

# ── 5. Remove onboard session file ──────────────────────────────────────────
info "Removing onboard session state…"
session_file="${HOME}/.nemoclaw/onboard-session.json"
if [[ -e "$session_file" ]]; then
  if rm -f "$session_file" 2>/dev/null || sudo rm -f "$session_file" 2>/dev/null; then
    ok "Removed ${session_file}"
  else
    warn "Could not remove ${session_file} (may need manual cleanup)"
  fi
else
  info "  No session file to remove"
fi

# ── 6. Verify GPU memory has been released ──────────────────────────────────
if [[ -n "$gpu_idx" ]] && command -v nvidia-smi >/dev/null 2>&1; then
  info "Verifying GPU memory release on GPU ${gpu_idx}…"
  vram_after=""
  prev=""
  attempts=0
  while (( attempts < 30 )); do
    vram_after=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits \
      -i "$gpu_idx" 2>/dev/null | tr -d ' ')
    if [[ -n "$prev" && "$vram_after" == "$prev" ]]; then
      break
    fi
    prev="$vram_after"
    sleep 1
    (( ++attempts ))
  done
  ok "GPU ${gpu_idx} VRAM used: ${vram_before:-?} MiB → ${vram_after:-?} MiB"
fi

# ── 7. Optional: purge HuggingFace model cache (--all) ──────────────────────
if [[ "$PURGE_CACHE" -eq 1 ]]; then
  info "Purging cached HuggingFace model weights…"
  hub="${HF_HOME:-${HOME}/.cache/huggingface}/hub"
  if [[ -d "$hub" ]]; then
    shopt -s nullglob
    matches=("$hub"/models--*)
    shopt -u nullglob
    if (( ${#matches[@]} > 0 )); then
      total_before=$(du -sh "$hub" 2>/dev/null | awk '{print $1}')
      for d in "${matches[@]}"; do
        [[ -d "$d" ]] || continue
        info "  Removing $(basename "$d")"
        rm -rf "$d"
      done
      ok "Model cache cleared (was ${total_before:-?})"
    else
      info "  No cached models found in ${hub}"
    fi
  else
    info "  No HuggingFace cache directory at ${hub}"
  fi
fi

printf "\n"
ok "Cleanup complete"
