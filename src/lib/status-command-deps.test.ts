// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { buildStatusCommandDeps } =
  require("../../dist/lib/status-command-deps.js") as typeof import("../../dist/lib/status-command-deps");
const GRPC_FAKE_SSH = path.join(import.meta.dirname, "..", "..", "test", "helpers", "grpc-fake-ssh.cjs");

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

describe("buildStatusCommandDeps", () => {
  let previousOverride: string | undefined;
  let previousHome: string | undefined;
  let previousPath: string | undefined;
  let previousGrpcTransport: string | undefined;
  let previousGrpcLegacy: string | undefined;
  let previousGrpcFakeSsh: string | undefined;
  let tmp: string;
  let callsFile: string;
  let openshell: string;

  beforeEach(() => {
    previousOverride = process.env.NEMOCLAW_OPENSHELL_BIN;
    previousHome = process.env.HOME;
    previousPath = process.env.PATH;
    previousGrpcTransport = process.env.NEMOCLAW_GRPC_TEST_TRANSPORT;
    previousGrpcLegacy = process.env.NEMOCLAW_GRPC_TEST_LEGACY_FAKE_SSH;
    previousGrpcFakeSsh = process.env.NEMOCLAW_GRPC_TEST_FAKE_SSH_BIN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-status-deps-"));
    callsFile = path.join(tmp, "openshell.calls");
    openshell = path.join(tmp, "openshell");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.HOME = tmp;
    process.env.PATH = `${tmp}${path.delimiter}${previousPath || ""}`;
    process.env.NEMOCLAW_GRPC_TEST_TRANSPORT = "1";
    process.env.NEMOCLAW_GRPC_TEST_LEGACY_FAKE_SSH = "1";
    process.env.NEMOCLAW_GRPC_TEST_FAKE_SSH_BIN = GRPC_FAKE_SSH;
  });

  afterEach(() => {
    if (previousOverride === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = previousOverride;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousGrpcTransport === undefined) {
      delete process.env.NEMOCLAW_GRPC_TEST_TRANSPORT;
    } else {
      process.env.NEMOCLAW_GRPC_TEST_TRANSPORT = previousGrpcTransport;
    }
    if (previousGrpcLegacy === undefined) {
      delete process.env.NEMOCLAW_GRPC_TEST_LEGACY_FAKE_SSH;
    } else {
      process.env.NEMOCLAW_GRPC_TEST_LEGACY_FAKE_SSH = previousGrpcLegacy;
    }
    if (previousGrpcFakeSsh === undefined) {
      delete process.env.NEMOCLAW_GRPC_TEST_FAKE_SSH_BIN;
    } else {
      process.env.NEMOCLAW_GRPC_TEST_FAKE_SSH_BIN = previousGrpcFakeSsh;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("detects Telegram conflict signatures from the gateway log", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  printf '7\n'
  exit 0
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["telegram"])).toEqual([
      { channel: "telegram", conflicts: 7 },
    ]);
    expect(fs.readFileSync(callsFile, "utf-8")).toContain(
      "sandbox exec --name alpha -- sh -c tail -n 200 /tmp/gateway.log",
    );
  });

  it("skips gateway-log probes for non-Telegram channel sets", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["slack", "discord"])).toEqual([]);
    expect(fs.existsSync(callsFile)).toBe(false);
  });

  it("returns null for empty gateway log tails and the log text otherwise", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  case "$*" in
    *"tail -n 10"*) printf 'line one\nline two\n'; exit 0 ;;
  esac
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);
    expect(deps.readGatewayLog?.("alpha")).toBe("line one\nline two");

    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
exit 0
`,
    );
    expect(deps.readGatewayLog?.("alpha")).toBeNull();
  });

  it("parses live gateway inference through the OpenShell override", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  echo 'Gateway inference:'
  echo '  Provider: nvidia-prod'
  echo '  Model: nvidia/nemotron'
  exit 0
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.getLiveInference()).toEqual({ provider: "nvidia-prod", model: "nvidia/nemotron" });
    expect(fs.readFileSync(callsFile, "utf-8")).toContain("inference get");
  });
});
