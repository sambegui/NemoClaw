#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

export PATH="${HOME}/.cargo/bin:${HOME}/.local/bin:${PATH}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENSHELL_REPO="${OPENSHELL_REPO:-/home/ubuntu/anikkulkarni/openshell-features/feat-shared-agent-memory}"
HERMES_REPO="${HERMES_REPO:-/home/ubuntu/anikkulkarni/hermes-agent}"
REDIS_CONTAINER="${REDIS_CONTAINER:-nemoclaw-shared-memory-redis}"
REDIS_PORT="${REDIS_PORT:-16379}"
GATEWAY_PORT="${GATEWAY_PORT:-18080}"
OPENSHELL_MEMORY_SCOPE="${OPENSHELL_MEMORY_SCOPE:-workspace:nemoclaw-demo}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-release-shared-memory-hermes}"
STATE_DIR="${STATE_DIR:-/tmp/nemoclaw-shared-memory-demo}"
KEEP_SERVICES="${KEEP_SERVICES:-0}"

MEMORY_URL="http://127.0.0.1:${GATEWAY_PORT}/v1"
GATEWAY_LOG="${STATE_DIR}/openshell-gateway.log"
OPENCLAW_AGENT="${REPO_ROOT}/examples/shared-memory/openclaw-agent.js"
HERMES_AGENT="${REPO_ROOT}/examples/shared-memory/hermes-agent.py"

mkdir -p "${STATE_DIR}"
gateway_pid=""
started_redis=0

cleanup() {
  if [[ "${KEEP_SERVICES}" == "1" ]]; then
    echo "Leaving demo services running."
    echo "  OpenShell gateway PID: ${gateway_pid}"
    echo "  Redis container: ${REDIS_CONTAINER}"
    echo "  Memory URL: ${MEMORY_URL}"
    return
  fi
  if [[ -n "${gateway_pid}" ]] && kill -0 "${gateway_pid}" >/dev/null 2>&1; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  if [[ "${started_redis}" == "1" ]]; then
    docker rm -f "${REDIS_CONTAINER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

wait_for_redis() {
  for _ in $(seq 1 30); do
    if docker exec "${REDIS_CONTAINER}" redis-cli ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Redis did not become ready." >&2
  exit 1
}

wait_for_gateway() {
  for _ in $(seq 1 180); do
    if curl -fsS "${MEMORY_URL}/memory/query?scope=${OPENSHELL_MEMORY_SCOPE}&limit=1" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "${gateway_pid}" ]] && ! kill -0 "${gateway_pid}" >/dev/null 2>&1; then
      echo "OpenShell gateway exited early. Log:" >&2
      tail -n 80 "${GATEWAY_LOG}" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "OpenShell gateway did not become ready. Log:" >&2
  tail -n 80 "${GATEWAY_LOG}" >&2 || true
  exit 1
}

json_arg() {
  jq -cn "$@"
}

run_openclaw() {
  OPENCLAW_AGENT_ID="openclaw:demo" \
    OPENSHELL_SANDBOX_ID="shared-memory-demo" \
    OPENSHELL_MEMORY_URL="${MEMORY_URL}" \
    OPENSHELL_MEMORY_SCOPE="${OPENSHELL_MEMORY_SCOPE}" \
    node "${OPENCLAW_AGENT}" "$@"
}

run_hermes() {
  HERMES_REPO="${HERMES_REPO}" \
    HERMES_AGENT_ID="hermes:demo" \
    OPENSHELL_SANDBOX_ID="shared-memory-demo" \
    OPENSHELL_MEMORY_URL="${MEMORY_URL}" \
    OPENSHELL_MEMORY_SCOPE="${OPENSHELL_MEMORY_SCOPE}" \
    uv --directory "${HERMES_REPO}" run --extra dev python "${HERMES_AGENT}" "$@"
}

require_command cargo
require_command curl
require_command docker
require_command jq
require_command node
require_command uv

if [[ ! -d "${OPENSHELL_REPO}" ]]; then
  echo "OpenShell repo not found: ${OPENSHELL_REPO}" >&2
  exit 1
fi
if [[ ! -d "${HERMES_REPO}" ]]; then
  echo "Hermes repo not found: ${HERMES_REPO}" >&2
  exit 1
fi

echo "Starting Redis on 127.0.0.1:${REDIS_PORT}"
if docker ps --format '{{.Names}}' | grep -qx "${REDIS_CONTAINER}"; then
  echo "  Reusing running Redis container ${REDIS_CONTAINER}"
elif docker ps -a --format '{{.Names}}' | grep -qx "${REDIS_CONTAINER}"; then
  docker start "${REDIS_CONTAINER}" >/dev/null
else
  docker run -d --rm \
    --name "${REDIS_CONTAINER}" \
    -p "127.0.0.1:${REDIS_PORT}:6379" \
    redis:7-alpine >/dev/null
  started_redis=1
fi
wait_for_redis

echo "Starting OpenShell gateway from ${OPENSHELL_REPO}"
(
  cd "${OPENSHELL_REPO}"
  OPENSHELL_MEMORY_BACKEND=redis \
    OPENSHELL_MEMORY_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
    cargo run --quiet --no-default-features -p openshell-server --bin openshell-gateway -- \
    --disable-tls \
    --bind-address 127.0.0.1 \
    --port "${GATEWAY_PORT}" \
    --db-url "sqlite:${STATE_DIR}/gateway.db?mode=rwc" \
    --grpc-endpoint "http://127.0.0.1:${GATEWAY_PORT}" \
    --drivers docker \
    --docker-network-name openshell-memory-demo
) >"${GATEWAY_LOG}" 2>&1 &
gateway_pid="$!"
wait_for_gateway
echo "  Gateway ready at ${MEMORY_URL}"

echo "Hermes subscribes to release.*"
run_hermes subscribe "$(
  json_arg --arg id "${SUBSCRIPTION_ID}" \
    '{subscription_id: $id, filters: {types: ["release.*"]}}'
)" | jq .

echo "OpenClaw publishes a release blocker for Hermes"
openclaw_event="$(
  run_openclaw publish "$(
    json_arg \
      '{
        event_type: "release.blocker.detected",
        subject: "shared-memory-mvp/hermes-adapter-smoke",
        content: {
          summary: "OpenClaw found that the shared-memory MVP release is blocked until the Hermes adapter smoke path is validated.",
          impact: "A user could launch OpenClaw and Hermes in the same OpenShell sandbox, but miss the Hermes handoff because the subscription path was not verified.",
          recommendation: "Have Hermes run the subscribe, receive, acknowledge, and respond flow against the OpenShell memory driver before the demo is marked ready.",
          evidence: [
            "OpenClaw successfully published through OPENSHELL_MEMORY_URL.",
            "Hermes must prove the release path by receiving the release.blocker.detected event through its subscription inbox."
          ]
        }
      }'
  )"
)"
echo "${openclaw_event}" | jq .
openclaw_event_id="$(echo "${openclaw_event}" | jq -r '.id')"

echo "Hermes pulls its subscription inbox and receives the OpenClaw blocker"
hermes_poll="$(run_hermes poll "$(json_arg --arg id "${SUBSCRIPTION_ID}" '{subscription_id: $id, limit: 10}')")"
echo "${hermes_poll}" | jq .
if ! echo "${hermes_poll}" | jq -e --arg id "${openclaw_event_id}" '.events[]?.id == $id' >/dev/null; then
  echo "Hermes subscription inbox did not include the OpenClaw event ${openclaw_event_id}" >&2
  exit 1
fi

echo "Hermes acknowledges the OpenClaw blocker"
run_hermes ack "$(
  json_arg --arg id "${SUBSCRIPTION_ID}" --arg event_id "${openclaw_event_id}" \
    '{subscription_id: $id, event_ids: [$event_id]}'
)" | jq .

echo "Hermes publishes a remediation plan for OpenClaw"
run_hermes publish "$(
  json_arg \
    '{
      event_type: "release.remediation.planned",
      subject: "hermes:demo",
      content: {
        state: "ready_for_validation",
        source_event: "release.blocker.detected",
        next_steps: [
          "Run the Hermes shared-memory adapter smoke path through OpenShell.",
          "Validate subscribe, pull, acknowledge, and response publishing against the release scope.",
          "Keep Redis behind OpenShell; agents never receive Redis credentials.",
          "Publish the remediation plan so OpenClaw can close the release blocker."
        ]
      }
    }'
)" | jq .

echo "OpenClaw queries Hermes remediation plan"
run_openclaw query "$(
  json_arg '{event_type: "release.remediation.planned", subject: "hermes:demo", limit: 10}'
)" | jq .

echo "Shared-memory MVP demo completed."
