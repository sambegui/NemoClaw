#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Smoke test for the verify-stale dogfood plumbing.
#
# Goal: prove the maintainer sandbox can do EVERYTHING the real run does
# (env validation, CLI install, gh/brev/ollama reachability, skill load,
# deterministic preflight) on exactly one target issue — without invoking
# the agent and without spending a cent on Brev.
#
# The target issue is chosen to make the deterministic preflight return
# SKIP for benign reasons (already labeled `fixed-on-latest`, or marker
# inside the 7-day TTL, etc.). A SKIP verdict here is SUCCESS for the
# smoke test — it means the plumbing got to the gate and the gate
# rejected the candidate as designed. A `fail: gh CLI not in PATH` or
# `fail: ollama not reachable at ...` is the real failure mode we want
# to surface BEFORE the operator launches the full 10-candidate batch.
#
# Usage:
#   source scripts/dogfood-env.sh
#   bash scripts/dogfood-smoke.sh [<issue-number>]
#
# If no issue number is given, the script auto-picks the most-recently-
# closed `fixed-on-latest` issue via gh (idempotency check will skip it).

set -euo pipefail

# -----------------------------------------------------------------------------
# Style helpers — match the orchestrator
# -----------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[smoke]${NC} $1"; }
ok()   { echo -e "${GREEN}[smoke]${NC} $1"; }
warn() { echo -e "${YELLOW}[smoke]${NC} $1" >&2; }
fail() {
  echo -e "${RED}[smoke]${NC} $1" >&2
  exit 1
}

# -----------------------------------------------------------------------------
# Phase A — env + CLI + reachability (delegated to a stripped-down repeat of
# the orchestrator's Phase 1-3, so we exercise the same code paths).
# -----------------------------------------------------------------------------

info "Phase A — env validation"

for v in BREV_API_TOKEN GH_TOKEN VERIFY_STALE_LOG_DIR BREV_BUDGET_USD; do
  [ -n "${!v:-}" ] || fail "env var '$v' is required. Did you 'source scripts/dogfood-env.sh'?"
done

# Override the dry-run + cap regardless of what the env file says — smoke is
# never live, never multi-candidate.
export VERIFY_STALE_DRY_RUN=1
export VERIFY_STALE_BATCH_CAP=1
export VERIFY_STALE_AUTO_APPROVE="${VERIFY_STALE_AUTO_APPROVE:-1}"
export VERIFY_STALE_FORCE_OLLAMA_ONLY="${VERIFY_STALE_FORCE_OLLAMA_ONLY:-1}"
export NEMOCLAW_NON_INTERACTIVE=1
export DOGFOOD_BREV_HOURLY_USD="${DOGFOOD_BREV_HOURLY_USD:-3}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-nemotron-3-nano:4b}"
export OLLAMA_URL="${OLLAMA_URL:-http://host.openshell.internal:11434}"

ok "  required env present; dry-run/cap pinned for smoke"

info "Phase B — CLI sanity (jq, gh, brev — installed if missing)"

if ! command -v jq >/dev/null 2>&1; then
  warn "  jq missing — orchestrator would install via apt. Skipping install in smoke."
  fail "install jq before running smoke (or run orchestrator's Phase 2 first)"
fi
if ! command -v gh >/dev/null 2>&1; then
  warn "  gh missing — orchestrator would install via apt. Skipping install in smoke."
  fail "install gh before running smoke (or run orchestrator's Phase 2 first)"
fi
if ! command -v brev >/dev/null 2>&1; then
  warn "  brev missing — orchestrator would install via curl. Skipping install in smoke."
  fail "install brev before running smoke (or run orchestrator's Phase 2 first)"
fi
if ! command -v openclaw >/dev/null 2>&1; then
  fail "openclaw not in PATH — the maintainer sandbox image is missing OpenClaw."
fi

ok "  jq, gh, brev, openclaw all callable"

info "Phase C — tokens + reachability"

gh auth status >/dev/null 2>&1 || fail "gh auth status failed; GH_TOKEN missing/invalid."
GH_SCOPES=$(gh auth status 2>&1 | grep -oE "Token scopes: .*" || true)
case "$GH_SCOPES" in
  *repo*) ok "  gh repo scope present" ;;
  *) fail "GH_TOKEN missing repo scope: $GH_SCOPES" ;;
esac
case "$GH_SCOPES" in
  *project*) ok "  gh project scope present" ;;
  *) warn "  gh project scope missing (warn-only; Project 199 moves will degrade)" ;;
esac

brev ls >/dev/null 2>&1 \
  || fail "brev ls failed; BREV_API_TOKEN invalid or brev preset not allowing egress."
ok "  brev ls works"

if ! curl -sf -m 5 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  fail "Ollama not reachable at $OLLAMA_URL — confirm ollama is running on host AND local-inference policy is on."
fi
if ! curl -sf -m 5 "$OLLAMA_URL/api/tags" \
   | jq -e --arg m "$OLLAMA_MODEL" '.models[] | select(.name == $m or .name == ($m + ":latest"))' >/dev/null; then
  fail "Ollama model '$OLLAMA_MODEL' not loaded on host. Run: ollama pull $OLLAMA_MODEL"
fi
ok "  ollama + model reachable"

# -----------------------------------------------------------------------------
# Phase D — skill workspace install (same as orchestrator Phase 4)
# -----------------------------------------------------------------------------

info "Phase D — skill workspace"

WORKSPACE_SKILLS="${OPENCLAW_WORKSPACE:-/sandbox/.openclaw/workspace}/skills"
SKILL_SRC="$(dirname "$(readlink -f "$0")")/../.agents/skills/nemoclaw-maintainer-verify-stale"
if [ ! -d "$SKILL_SRC" ]; then
  fail "skill source not found at $SKILL_SRC — smoke must run from a NemoClaw checkout."
fi
mkdir -p "$WORKSPACE_SKILLS"
ln -sfn "$SKILL_SRC" "$WORKSPACE_SKILLS/nemoclaw-maintainer-verify-stale"
ok "  skill symlinked at $WORKSPACE_SKILLS/nemoclaw-maintainer-verify-stale"

# -----------------------------------------------------------------------------
# Phase E — pick a target issue + smoke log dir
# -----------------------------------------------------------------------------

info "Phase E — target issue selection"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  # Auto-pick: most recent issue with `fixed-on-latest` label. Idempotency
  # check will SKIP it, so we get a clean preflight gate without Brev cost.
  TARGET=$(gh issue list --repo NVIDIA/NemoClaw \
            --label fixed-on-latest --state all --limit 1 \
            --json number --jq '.[0].number' 2>/dev/null || echo "")
  if [ -z "$TARGET" ] || [ "$TARGET" = "null" ]; then
    fail "no auto-pick target found (no fixed-on-latest issues exist?). Pass an issue number explicitly: bash scripts/dogfood-smoke.sh 1234"
  fi
  ok "  auto-picked issue #$TARGET (most-recent fixed-on-latest)"
else
  TARGET="${TARGET#\#}"
  ok "  using operator-supplied issue #$TARGET"
fi

SMOKE_DIR="$VERIFY_STALE_LOG_DIR/smoke-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SMOKE_DIR"
ln -sfn "$SMOKE_DIR" "$VERIFY_STALE_LOG_DIR/latest-smoke"
export VERIFY_STALE_LOG_DIR="$SMOKE_DIR"  # preflight writes under this root
echo 0 > "$SMOKE_DIR/.spent-usd"
ok "  smoke log dir: $SMOKE_DIR"

# -----------------------------------------------------------------------------
# Phase F — fetch the target's reported version (best effort; preflight
# handles empty hints by deferring to the agent's Step 4)
# -----------------------------------------------------------------------------

info "Phase F — reported-version hint"

# Look at labels first (Step 4 trust order); fall back to empty.
REPORTED=$(gh issue view "$TARGET" --repo NVIDIA/NemoClaw --json labels \
  --jq '[.labels[].name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))] | .[0] // ""')
if [ -n "$REPORTED" ]; then
  ok "  reported-version hint from label: $REPORTED"
else
  warn "  no version label on #$TARGET; preflight will report 'no version hint' (caveat, not fail)"
fi

# -----------------------------------------------------------------------------
# Phase G — run the deterministic preflight on the target
# -----------------------------------------------------------------------------

info "Phase G — deterministic preflight"

PREFLIGHT="$(dirname "$(readlink -f "$0")")/dogfood-preflight.sh"
[ -x "$PREFLIGHT" ] || fail "preflight script not executable at $PREFLIGHT"

set +e
"$PREFLIGHT" "$TARGET" "$REPORTED"
preflight_rc=$?
set -e

PREFLIGHT_OUT="$SMOKE_DIR/$TARGET/preflight.json"
if [ ! -f "$PREFLIGHT_OUT" ]; then
  fail "preflight did not write $PREFLIGHT_OUT — script exited rc=$preflight_rc"
fi

VERDICT=$(jq -r '.verdict' "$PREFLIGHT_OUT")
info "  preflight verdict: $VERDICT (rc=$preflight_rc)"
jq '.checks' "$PREFLIGHT_OUT"

# -----------------------------------------------------------------------------
# Phase H — interpret the smoke result
# -----------------------------------------------------------------------------

echo
case "$VERDICT" in
  SKIP)
    SKIP_REASON=$(jq -r '.skip_reason' "$PREFLIGHT_OUT")
    ok "SMOKE PASSED. Plumbing reached the preflight gate; gate rejected as expected ($SKIP_REASON)."
    ok "Safe to run the full orchestrator: bash scripts/dogfood-orchestrator.sh"
    exit 0
    ;;
  PROCEED|PROCEED-WITH-CAVEATS)
    warn "Preflight said $VERDICT on #$TARGET — meaning the agent WOULD have been invoked"
    warn "in the real orchestrator. That's still a smoke pass (the plumbing works), but"
    warn "the target wasn't a guaranteed-SKIP candidate."
    warn "Try a more reliable smoke target by passing an explicit issue number that's"
    warn "already labeled fixed-on-latest:  bash scripts/dogfood-smoke.sh <issue>"
    ok "SMOKE PASSED (plumbing healthy; preflight gate working)."
    exit 0
    ;;
  *)
    fail "unexpected preflight verdict '$VERDICT' — inspect $PREFLIGHT_OUT"
    ;;
esac
