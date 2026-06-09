// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { expectFailure } from "../framework/expect-failure.ts";
import type { ShellProbeResult } from "../framework/shell-probe.ts";

function result(overrides: Partial<ShellProbeResult> = {}): ShellProbeResult {
  return {
    command: ["nemoclaw", "onboard"],
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
    ...overrides,
  };
}

describe("expectFailure", () => {
  it("returns the contract when the command failed and advertised the errorClass", () => {
    const outcome = expectFailure(result({ stderr: "preflight failed: docker-missing" }), {
      phase: "preflight",
      errorClass: "docker-missing",
      forbiddenSideEffects: ["gateway-started", "sandbox-created"],
    });

    expect(outcome).toEqual({
      phase: "preflight",
      errorClass: "docker-missing",
      forbiddenSideEffects: ["gateway-started", "sandbox-created"],
      exitCode: 1,
      signal: null,
    });
  });

  it("matches errorClass with interchangeable separators and case", () => {
    expect(() =>
      expectFailure(result({ stdout: "Gateway Port Conflict on :8080" }), {
        phase: "preflight",
        errorClass: "gateway-port-conflict",
      }),
    ).not.toThrow();
  });

  it("treats a terminating signal as a failure", () => {
    const outcome = expectFailure(result({ exitCode: null, signal: "SIGTERM", stderr: "docker-missing" }), {
      phase: "preflight",
      errorClass: "docker-missing",
    });
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.forbiddenSideEffects).toEqual([]);
  });

  it("throws when the command exited 0", () => {
    expect(() =>
      expectFailure(result({ exitCode: 0, stdout: "docker-missing" }), {
        phase: "preflight",
        errorClass: "docker-missing",
      }),
    ).toThrow(/expected the command to fail, but it exited 0/);
  });

  it("throws when the failure does not advertise the declared errorClass", () => {
    expect(() =>
      expectFailure(result({ stderr: "some unrelated error" }), {
        phase: "preflight",
        errorClass: "docker-missing",
      }),
    ).toThrow(/did not advertise errorClass "docker-missing"/);
  });

  it("rejects an empty errorClass", () => {
    expect(() => expectFailure(result(), { phase: "preflight", errorClass: "  " })).toThrow(
      /non-empty errorClass/,
    );
  });
});
