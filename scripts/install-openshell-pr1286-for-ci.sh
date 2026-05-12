#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Temporary CI helper for NemoClaw PR #3323. This lets that PR's nightly
# messaging jobs prove the OpenShell PR #1286 integration before an official
# OpenShell release contains the required native messaging rewrite features.

OPENSHELL_PR1286_REPO="${OPENSHELL_PR1286_REPO:-https://github.com/ericksoa/OpenShell.git}"
OPENSHELL_PR1286_BRANCH="${OPENSHELL_PR1286_BRANCH:-fix/872-websocket-credential-rewrite}"
OPENSHELL_PR1286_COMMIT="${OPENSHELL_PR1286_COMMIT:-d391cfce299cb96d268a0997993fc9971475ef36}"

runner_temp="${RUNNER_TEMP:-/tmp}"
openshell_src="${runner_temp}/openshell-pr1286"
openshell_bin_dir="${runner_temp}/openshell-pr1286-bin"
cargo_target_dir="${CARGO_TARGET_DIR:-${openshell_src}/target}"

rm -rf "$openshell_src" "$openshell_bin_dir"
mkdir -p "$openshell_src" "$openshell_bin_dir"

git -C "$openshell_src" init
git -C "$openshell_src" remote add origin "$OPENSHELL_PR1286_REPO"
git -C "$openshell_src" fetch --force origin \
  "refs/heads/${OPENSHELL_PR1286_BRANCH}:refs/remotes/origin/${OPENSHELL_PR1286_BRANCH}" \
  "refs/tags/v*:refs/tags/v*"
git -C "$openshell_src" checkout --detach "$OPENSHELL_PR1286_COMMIT"

actual_commit="$(git -C "$openshell_src" rev-parse HEAD)"
if [ "$actual_commit" != "$OPENSHELL_PR1286_COMMIT" ]; then
  echo "Expected OpenShell $OPENSHELL_PR1286_COMMIT but checked out $actual_commit" >&2
  exit 1
fi

rustup toolchain install 1.88.0 --profile minimal
export CARGO_TARGET_DIR="$cargo_target_dir"
cargo +1.88.0 build --locked --manifest-path "$openshell_src/Cargo.toml" -p openshell-cli --bin openshell
cargo +1.88.0 build --locked --manifest-path "$openshell_src/Cargo.toml" -p openshell-server --bin openshell-gateway
cargo +1.88.0 build --locked --manifest-path "$openshell_src/Cargo.toml" -p openshell-sandbox --bin openshell-sandbox

install -m 0755 "$cargo_target_dir/debug/openshell" "$openshell_bin_dir/openshell"
install -m 0755 "$cargo_target_dir/debug/openshell-gateway" "$openshell_bin_dir/openshell-gateway"
install -m 0755 "$cargo_target_dir/debug/openshell-sandbox" "$openshell_bin_dir/openshell-sandbox"

grep -aFq "request-body-credential-rewrite" "$openshell_bin_dir/openshell"
grep -aFq "websocket-credential-rewrite" "$openshell_bin_dir/openshell"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$openshell_bin_dir" >> "$GITHUB_PATH"
fi
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NEMOCLAW_OPENSHELL_BIN=$openshell_bin_dir/openshell" >> "$GITHUB_ENV"
fi

"$openshell_bin_dir/openshell" --version
