#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Small CLI wrapper for the Hermes shared-memory tool used by the local demo."""

import json
import os
import sys
from pathlib import Path


def _hermes_repo() -> Path:
    return Path(
        os.environ.get("HERMES_REPO", "/home/ubuntu/anikkulkarni/hermes-agent")
    ).resolve()


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: hermes-agent.py <publish|query|subscribe|poll|ack> [json-args]",
            file=sys.stderr,
        )
        return 2

    action = sys.argv[1]
    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"
    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError as error:
        print(f"invalid JSON args: {error}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(_hermes_repo()))
    from tools.shared_memory_tool import shared_memory_tool

    result_text = shared_memory_tool({"action": action, **args})
    print(result_text)
    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        return 0
    return 1 if isinstance(result, dict) and result.get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
