// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "../shell-probe.ts";
import { assertExitZero } from "./command.ts";
import type { HostCliClient } from "./host.ts";

export class GatewayClient {
  private readonly host: HostCliClient;

  constructor(host: HostCliClient) {
    this.host = host;
  }

  status(): Promise<ShellProbeResult> {
    return this.host.nemoclaw(["gateway", "status"], { artifactName: "gateway-status" });
  }

  async expectHealthy(): Promise<ShellProbeResult> {
    const result = await this.status();
    assertExitZero(result, "nemoclaw gateway status");
    return result;
  }

  /**
   * Assert no gateway was started — the negative-scenario counterpart to
   * `expectHealthy`. Mirrors the `gateway-absent` probe: a successful
   * `nemoclaw gateway status` (exit 0) means the gateway IS running, which is a
   * forbidden side effect for a preflight/onboarding failure.
   */
  async expectAbsent(): Promise<ShellProbeResult> {
    const result = await this.status();
    if (result.exitCode === 0) {
      const detail = result.stdout.trim() || result.stderr.trim() || "exit=0";
      throw new Error(`expected gateway to be absent, but \`nemoclaw gateway status\` reports it running: ${detail}`);
    }
    return result;
  }
}
