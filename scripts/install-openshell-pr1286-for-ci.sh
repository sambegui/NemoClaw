#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Temporary CI helper for NemoClaw PR #3323. It mirrors OpenShell's own
# release build shape instead of compiling ad hoc on the host runner:
#   - OpenShell CI image
#   - mise-managed Rust/Zig toolchain
#   - musl CLI with bundled Z3
#   - GNU gateway/sandbox binaries with dev-settings feature
# Remove this after OpenShell PR #1286 is available in the normal release
# channel consumed by scripts/install-openshell.sh.

OPENSHELL_PR1286_REPO="${OPENSHELL_PR1286_REPO:-https://github.com/ericksoa/OpenShell.git}"
OPENSHELL_PR1286_BRANCH="${OPENSHELL_PR1286_BRANCH:-fix/872-websocket-credential-rewrite}"
OPENSHELL_PR1286_COMMIT="${OPENSHELL_PR1286_COMMIT:-077544834681aa3c00f71a7d50a9efcd37afb5ad}"
OPENSHELL_CI_IMAGE="${OPENSHELL_CI_IMAGE:-ghcr.io/nvidia/openshell/ci:latest}"

runner_temp="${RUNNER_TEMP:-/tmp}"
openshell_src="${runner_temp}/openshell-pr1286"
openshell_out="${runner_temp}/openshell-pr1286-out"
openshell_bin_dir="${OPENSHELL_PR1286_INSTALL_DIR:-${runner_temp}/openshell-pr1286-bin}"

case "$(uname -m)" in
  x86_64 | amd64)
    cli_target="x86_64-unknown-linux-musl"
    gnu_target="x86_64-unknown-linux-gnu"
    zig_target="x86_64-linux-musl"
    ;;
  aarch64 | arm64)
    cli_target="aarch64-unknown-linux-musl"
    gnu_target="aarch64-unknown-linux-gnu"
    zig_target="aarch64-linux-musl"
    ;;
  *)
    echo "Unsupported architecture for OpenShell PR #1286 CI build: $(uname -m)" >&2
    exit 1
    ;;
esac

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required to use the OpenShell CI build image" >&2; exit 1; }

rm -rf "$openshell_src" "$openshell_out"
if [ -z "${OPENSHELL_PR1286_INSTALL_DIR:-}" ]; then
  rm -rf "$openshell_bin_dir"
fi
mkdir -p "$openshell_src" "$openshell_out" "$openshell_bin_dir"

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

if [ -n "${GITHUB_TOKEN:-}" ]; then
  printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:-github-actions}" --password-stdin
fi

docker run --rm \
  -e CARGO_TERM_COLOR=always \
  -e CARGO_INCREMENTAL=0 \
  -e MISE_GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  -e OPENSHELL_IMAGE_TAG="$OPENSHELL_PR1286_COMMIT" \
  -v "$openshell_src:/work" \
  -v "$openshell_out:/out" \
  -w /work \
  "$OPENSHELL_CI_IMAGE" \
  bash -s -- "$cli_target" "$gnu_target" "$zig_target" <<'OPENSHELL_BUILD_EOF'
set -euo pipefail

cli_target="$1"
gnu_target="$2"
zig_target="$3"

git config --global --add safe.directory /work
git fetch --tags --force
mise install --locked
mise x -- rustup target add "$cli_target" "$gnu_target"

zig="$(mise which zig)"
mkdir -p /tmp/zig-musl
for tool in cc c++; do
  cat >"/tmp/zig-musl/${tool}" <<EOF
#!/bin/bash
args=()
for arg in "\$@"; do
  case "\$arg" in
    --target=*) ;;
    *) args+=("\$arg") ;;
  esac
done
exec "$zig" "$tool" --target="$zig_target" "\${args[@]}"
EOF
  chmod +x "/tmp/zig-musl/${tool}"
done

target_env="${cli_target//-/_}"
target_env_upper="${target_env^^}"
export "CC_${target_env}=/tmp/zig-musl/cc"
export "CXX_${target_env}=/tmp/zig-musl/c++"
export "CARGO_TARGET_${target_env_upper}_LINKER=/tmp/zig-musl/cc"
export "CARGO_TARGET_${target_env_upper}_RUSTFLAGS=-Clink-self-contained=no"
export CXXSTDLIB=c++

mise x -- cargo build --release --target "$cli_target" -p openshell-cli --features bundled-z3
mise x -- cargo build --release --target "$gnu_target" -p openshell-server --bin openshell-gateway --features openshell-core/dev-settings
mise x -- cargo build --release --target "$gnu_target" -p openshell-sandbox --bin openshell-sandbox --features openshell-core/dev-settings

install -m 0755 "target/${cli_target}/release/openshell" /out/openshell
install -m 0755 "target/${gnu_target}/release/openshell-gateway" /out/openshell-gateway
install -m 0755 "target/${gnu_target}/release/openshell-sandbox" /out/openshell-sandbox
ls -lh /out
OPENSHELL_BUILD_EOF

install -m 0755 "$openshell_out/openshell" "$openshell_bin_dir/openshell"
install -m 0755 "$openshell_out/openshell-gateway" "$openshell_bin_dir/openshell-gateway"
install -m 0755 "$openshell_out/openshell-sandbox" "$openshell_bin_dir/openshell-sandbox"

grep -aFq "request-body-credential-rewrite" "$openshell_bin_dir/openshell"
grep -aFq "websocket-credential-rewrite" "$openshell_bin_dir/openshell"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$openshell_bin_dir" >> "$GITHUB_PATH"
fi
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NEMOCLAW_OPENSHELL_BIN=$openshell_bin_dir/openshell" >> "$GITHUB_ENV"
fi

"$openshell_bin_dir/openshell" --version
"$openshell_bin_dir/openshell-gateway" --version
"$openshell_bin_dir/openshell-sandbox" --version
