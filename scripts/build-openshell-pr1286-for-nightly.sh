#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

log() {
  printf '[openshell-pr1286] %s\n' "$*"
}

fail() {
  printf '[openshell-pr1286] ERROR: %s\n' "$*" >&2
  exit 1
}

PINNED_COMMIT="077544834681aa3c00f71a7d50a9efcd37afb5ad"
OPEN_SHELL_REPO_URL="https://github.com/ericksoa/OpenShell.git"
OPEN_SHELL_BRANCH="fix/872-websocket-credential-rewrite"
OPEN_SHELL_PR_URL="https://github.com/NVIDIA/OpenShell/pull/1286"
OPEN_SHELL_CI_IMAGE="ghcr.io/nvidia/openshell/ci:latest"

requested_commit="${OPENSHELL_PR1286_COMMIT:-$PINNED_COMMIT}"
if [ "$requested_commit" != "$PINNED_COMMIT" ]; then
  fail "OPENSHELL_PR1286_COMMIT must be $PINNED_COMMIT, got $requested_commit"
fi

case "$(uname -m)" in
  x86_64 | amd64)
    rust_musl_target="x86_64-unknown-linux-musl"
    rust_gnu_target="x86_64-unknown-linux-gnu"
    zig_target="x86_64-linux-musl"
    ;;
  aarch64 | arm64)
    rust_musl_target="aarch64-unknown-linux-musl"
    rust_gnu_target="aarch64-unknown-linux-gnu"
    zig_target="aarch64-linux-musl"
    ;;
  *)
    fail "unsupported build architecture: $(uname -m)"
    ;;
esac

command -v docker >/dev/null 2>&1 || fail "docker is required to build OpenShell PR #1286"

install_dir="${HOME}/.local/bin"
mkdir -p "$install_dir"

work_dir="$(mktemp -d)"
out_dir="${work_dir}/out"
mkdir -p "$out_dir"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

log "OpenShell repo: $OPEN_SHELL_REPO_URL"
log "OpenShell branch: $OPEN_SHELL_BRANCH"
log "OpenShell PR: $OPEN_SHELL_PR_URL"
log "OpenShell pinned commit: $PINNED_COMMIT"
log "OpenShell CI image: $OPEN_SHELL_CI_IMAGE"
log "Rust targets: $rust_musl_target, $rust_gnu_target"

if [ -n "${GITHUB_TOKEN:-}" ]; then
  log "Logging in to ghcr.io with GITHUB_TOKEN for CI image pull"
  printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:-github-actions}" --password-stdin >/dev/null
else
  log "GITHUB_TOKEN not set; attempting unauthenticated CI image pull"
fi

docker pull "$OPEN_SHELL_CI_IMAGE"

docker run --rm --privileged \
  -e "OPEN_SHELL_REPO_URL=$OPEN_SHELL_REPO_URL" \
  -e "OPEN_SHELL_BRANCH=$OPEN_SHELL_BRANCH" \
  -e "OPEN_SHELL_PR_URL=$OPEN_SHELL_PR_URL" \
  -e "PINNED_COMMIT=$PINNED_COMMIT" \
  -e "RUST_MUSL_TARGET=$rust_musl_target" \
  -e "RUST_GNU_TARGET=$rust_gnu_target" \
  -e "ZIG_TARGET=$zig_target" \
  -e "HOST_UID=$(id -u)" \
  -e "HOST_GID=$(id -g)" \
  -e "MISE_GITHUB_TOKEN=${GITHUB_TOKEN:-}" \
  -e "OPENSHELL_IMAGE_TAG=$PINNED_COMMIT" \
  -v "$out_dir:/out" \
  "$OPEN_SHELL_CI_IMAGE" \
  bash -lc '
    set -euo pipefail

    log() {
      printf "[openshell-pr1286:container] %s\n" "$*"
    }

    fail() {
      printf "[openshell-pr1286:container] ERROR: %s\n" "$*" >&2
      exit 1
    }

    clone_dir="$(mktemp -d)"
    trap "rm -rf \"$clone_dir\"" EXIT

    log "Fresh-cloning ${OPEN_SHELL_REPO_URL}"
    git clone --no-checkout "${OPEN_SHELL_REPO_URL}" "$clone_dir/OpenShell"
    cd "$clone_dir/OpenShell"
    git remote -v
    log "Fetching branch ${OPEN_SHELL_BRANCH}"
    git fetch --force origin "${OPEN_SHELL_BRANCH}"
    log "Fetching tags"
    git fetch --tags --force origin
    git checkout --detach "$PINNED_COMMIT"
    actual_commit="$(git rev-parse HEAD)"
    [ "$actual_commit" = "$PINNED_COMMIT" ] || fail "checked out $actual_commit, expected $PINNED_COMMIT"
    log "Checked out ${OPEN_SHELL_PR_URL} at ${actual_commit}"

    git config --global --add safe.directory "$PWD"

    log "Installing mise tools from lockfile"
    mise install --locked

    log "Adding Rust targets ${RUST_MUSL_TARGET} and ${RUST_GNU_TARGET}"
    mise x -- rustup target add "$RUST_MUSL_TARGET" "$RUST_GNU_TARGET"

    log "Setting up Zig musl wrappers"
    ZIG="$(mise which zig)"
    mkdir -p /tmp/zig-musl
    for tool in cc c++; do
      printf '"'"'#!/bin/bash\nargs=()\nfor arg in "$@"; do\n  case "$arg" in\n    --target=*) ;;\n    *) args+=("$arg") ;;\n  esac\ndone\nexec "%s" %s --target=%s "${args[@]}"\n'"'"' \
        "$ZIG" "$tool" "$ZIG_TARGET" > "/tmp/zig-musl/${tool}"
      chmod +x "/tmp/zig-musl/${tool}"
    done

    target_env="$(echo "$RUST_MUSL_TARGET" | tr "-" "_")"
    target_env_upper="${target_env^^}"
    export "CC_${target_env}=/tmp/zig-musl/cc"
    export "CXX_${target_env}=/tmp/zig-musl/c++"
    export "CARGO_TARGET_${target_env_upper}_LINKER=/tmp/zig-musl/cc"
    export "CARGO_TARGET_${target_env_upper}_RUSTFLAGS=-Clink-self-contained=no"
    export CXXSTDLIB=c++

    cargo_version="$(uv run python tasks/scripts/release.py get-version --cargo)"
    [ -n "$cargo_version" ] || fail "release.py returned an empty cargo version"
    log "Patching workspace cargo version to ${cargo_version}"
    sed -i -E '"'"'/^\[workspace\.package\]/,/^\[/{s/^version[[:space:]]*=[[:space:]]*".*"/version = "'"'"'"${cargo_version}"'"'"'"/}'"'"' Cargo.toml

    log "Building openshell CLI (${RUST_MUSL_TARGET})"
    mise x -- cargo build --release --target "$RUST_MUSL_TARGET" -p openshell-cli --features bundled-z3

    log "Building openshell gateway (${RUST_GNU_TARGET})"
    mise x -- cargo build --release --target "$RUST_GNU_TARGET" -p openshell-server

    log "Building openshell sandbox (${RUST_GNU_TARGET})"
    mise x -- cargo build --release --target "$RUST_GNU_TARGET" -p openshell-sandbox --bin openshell-sandbox

    install -m 755 "target/${RUST_MUSL_TARGET}/release/openshell" /out/openshell
    install -m 755 "target/${RUST_GNU_TARGET}/release/openshell-gateway" /out/openshell-gateway
    install -m 755 "target/${RUST_GNU_TARGET}/release/openshell-sandbox" /out/openshell-sandbox
    chown "${HOST_UID}:${HOST_GID}" /out/openshell /out/openshell-gateway /out/openshell-sandbox

    /out/openshell --version
    /out/openshell-gateway --version
    /out/openshell-sandbox --version
    strings /out/openshell | grep -F request-body-credential-rewrite >/dev/null
    strings /out/openshell | grep -F websocket-credential-rewrite >/dev/null
    log "Built and verified PR #1286 binaries"
  '

install -m 755 "$out_dir/openshell" "$install_dir/openshell"
install -m 755 "$out_dir/openshell-gateway" "$install_dir/openshell-gateway"
install -m 755 "$out_dir/openshell-sandbox" "$install_dir/openshell-sandbox"

export PATH="$install_dir:$PATH"
export NEMOCLAW_OPENSHELL_BIN="$install_dir/openshell"
export NEMOCLAW_OPENSHELL_GATEWAY_BIN="$install_dir/openshell-gateway"
export NEMOCLAW_OPENSHELL_SANDBOX_BIN="$install_dir/openshell-sandbox"
export NEMOCLAW_OPENSHELL_PR1286_COMMIT="$PINNED_COMMIT"

log "Installed openshell: $NEMOCLAW_OPENSHELL_BIN"
"$NEMOCLAW_OPENSHELL_BIN" --version
log "Installed openshell-gateway: $NEMOCLAW_OPENSHELL_GATEWAY_BIN"
"$NEMOCLAW_OPENSHELL_GATEWAY_BIN" --version
log "Installed openshell-sandbox: $NEMOCLAW_OPENSHELL_SANDBOX_BIN"
"$NEMOCLAW_OPENSHELL_SANDBOX_BIN" --version

strings "$NEMOCLAW_OPENSHELL_BIN" | grep -F request-body-credential-rewrite >/dev/null \
  || fail "openshell binary is missing request-body-credential-rewrite"
strings "$NEMOCLAW_OPENSHELL_BIN" | grep -F websocket-credential-rewrite >/dev/null \
  || fail "openshell binary is missing websocket-credential-rewrite"

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$install_dir" >>"$GITHUB_PATH"
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    printf 'NEMOCLAW_OPENSHELL_BIN=%s\n' "$NEMOCLAW_OPENSHELL_BIN"
    printf 'NEMOCLAW_OPENSHELL_GATEWAY_BIN=%s\n' "$NEMOCLAW_OPENSHELL_GATEWAY_BIN"
    printf 'NEMOCLAW_OPENSHELL_SANDBOX_BIN=%s\n' "$NEMOCLAW_OPENSHELL_SANDBOX_BIN"
    printf 'NEMOCLAW_OPENSHELL_PR1286_COMMIT=%s\n' "$NEMOCLAW_OPENSHELL_PR1286_COMMIT"
  } >>"$GITHUB_ENV"
fi

log "OpenShell PR #1286 binaries are ready on PATH"
