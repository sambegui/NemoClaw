// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { gpuPassthroughRecoveryLines, reportGpuPassthroughRecovery } from "./onboard/gpu-recovery";

describe("gpuPassthroughRecoveryLines", () => {
  it("suggests uninstall when no sandboxes are registered (no actionable destroy target)", () => {
    const lines = gpuPassthroughRecoveryLines([]);
    expect(lines).toEqual([
      "  Existing gateway was started without GPU passthrough.",
      "  No sandboxes are registered, so there is nothing to destroy.",
      "  To enable GPU, clear the stale gateway state and re-onboard:",
      "    nemoclaw uninstall && nemoclaw onboard --gpu",
    ]);
  });

  it("names the registered sandbox in the destroy command (singular form)", () => {
    const lines = gpuPassthroughRecoveryLines(["my-assistant"]);
    expect(lines).toEqual([
      "  Existing gateway was started without GPU passthrough.",
      "  To enable GPU, destroy the registered sandbox (`my-assistant`) and re-onboard:",
      "    nemoclaw my-assistant destroy --yes",
      "    nemoclaw onboard --gpu",
    ]);
  });

  it("lists every registered sandbox (plural form)", () => {
    const lines = gpuPassthroughRecoveryLines(["alpha", "beta"]);
    expect(lines).toEqual([
      "  Existing gateway was started without GPU passthrough.",
      "  To enable GPU, destroy the registered sandboxes (`alpha`, `beta`) and re-onboard:",
      "    nemoclaw alpha destroy --yes",
      "    nemoclaw beta destroy --yes",
      "    nemoclaw onboard --gpu",
    ]);
  });

  it("never emits the literal `<name>` placeholder in any suggestion", () => {
    expect(gpuPassthroughRecoveryLines([]).join("\n")).not.toContain("<name>");
    expect(gpuPassthroughRecoveryLines(["x"]).join("\n")).not.toContain("<name>");
    expect(gpuPassthroughRecoveryLines(["alpha", "beta"]).join("\n")).not.toContain("<name>");
  });
});

describe("reportGpuPassthroughRecovery", () => {
  it("routes the registered sandbox names through the printer", () => {
    const printed: string[] = [];
    reportGpuPassthroughRecovery((line) => printed.push(line), () => ["alpha"]);
    expect(printed).toEqual(gpuPassthroughRecoveryLines(["alpha"]));
  });

  it("falls back to the no-sandbox guidance when the registry lookup throws", () => {
    const printed: string[] = [];
    reportGpuPassthroughRecovery(
      (line) => printed.push(line),
      () => {
        throw new Error("registry unreachable");
      },
    );
    expect(printed).toEqual(gpuPassthroughRecoveryLines([]));
  });
});
