// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  assertDashboardPortNotReservedForHermesApi,
  reservedHermesApiPorts,
} from "./hermes-dashboard-port-guard";

// Mirrors the Hermes manifest: dashboard forward on 18789, OpenAI-compatible
// API / health probe on 8642 (agents/hermes/manifest.yaml).
const hermesAgent = {
  forwardPort: 18789,
  forward_ports: [18789, 8642],
  healthProbe: { port: 8642 },
};

describe("reservedHermesApiPorts", () => {
  it("reserves the Hermes API port but not the dashboard forward port", () => {
    expect(reservedHermesApiPorts(hermesAgent)).toEqual([8642]);
  });

  it("derives the reserved API port from the health probe when forward_ports is absent", () => {
    expect(reservedHermesApiPorts({ forwardPort: 18789, healthProbe: { port: 8642 } })).toEqual([
      8642,
    ]);
  });
});

describe("assertDashboardPortNotReservedForHermesApi", () => {
  it("rejects NEMOCLAW_DASHBOARD_PORT=8642 with a [SECURITY] error before sandbox create", () => {
    const fail = vi.fn((message: string) => {
      throw new Error(message);
    });
    expect(() =>
      assertDashboardPortNotReservedForHermesApi({
        agentName: "hermes",
        dashboardPort: 8642,
        agent: hermesAgent,
        fail: fail as unknown as (message: string) => never,
      }),
    ).toThrow(
      "[SECURITY] Invalid Hermes dashboard port 8642 - reserved for the Hermes OpenAI-compatible API.",
    );
    expect(fail).toHaveBeenCalledOnce();
  });

  it("allows the default dashboard port for Hermes", () => {
    const fail = vi.fn();
    assertDashboardPortNotReservedForHermesApi({
      agentName: "hermes",
      dashboardPort: 18789,
      agent: hermesAgent,
      fail: fail as unknown as (message: string) => never,
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not reserve Hermes API ports for non-Hermes agents", () => {
    const fail = vi.fn();
    assertDashboardPortNotReservedForHermesApi({
      agentName: "openclaw",
      dashboardPort: 8642,
      agent: { forwardPort: 18789, forward_ports: [18789] },
      fail: fail as unknown as (message: string) => never,
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it("is a no-op when no explicit dashboard port is requested (auto-allocation)", () => {
    const fail = vi.fn();
    assertDashboardPortNotReservedForHermesApi({
      agentName: "hermes",
      dashboardPort: null,
      agent: hermesAgent,
      fail: fail as unknown as (message: string) => never,
    });
    expect(fail).not.toHaveBeenCalled();
  });
});
