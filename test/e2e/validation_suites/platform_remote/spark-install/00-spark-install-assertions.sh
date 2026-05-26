#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/platform_remote.sh"
e2e_platform_remote_load_context
for id in \
  expected.platform_remote.spark.prereq-linux-platform \
  expected.platform_remote.spark.prereq-docker-running \
  expected.platform_remote.spark.prereq-noninteractive-env \
  expected.platform_remote.spark.prereq-third-party-acceptance \
  expected.platform_remote.spark.generic-installer-flow \
  expected.platform_remote.spark.install-exits-zero \
  expected.platform_remote.spark.nemoclaw-on-path \
  expected.platform_remote.spark.openshell-on-path \
  expected.platform_remote.spark.nemoclaw-help \
  expected.platform_remote.spark.user-local-ollama-fallback; do
  e2e_platform_remote_assertion "$id"
done
