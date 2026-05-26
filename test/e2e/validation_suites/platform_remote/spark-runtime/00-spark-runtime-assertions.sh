#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/platform_remote.sh"
e2e_platform_remote_load_context
for id in \
  expected.platform_remote.spark.delivery-chain-health-accepts-forward \
  expected.platform_remote.spark.old-ollama-upgrade-path \
  expected.platform_remote.spark.model-selection-available-memory \
  expected.platform_remote.sandbox.build-context-readable-by-user \
  expected.platform_remote.spark.gpu-recreate-preserves-start-command; do
  e2e_platform_remote_assertion "$id"
done
