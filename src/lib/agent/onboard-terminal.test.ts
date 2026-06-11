// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { loadAgent } from "../../../dist/lib/agent/defs";
// Import from compiled dist/ so coverage is attributed correctly.
import { handleAgentSetup } from "../../../dist/lib/agent/onboard";
import type { AgentDefinition } from "./defs";

type RunCaptureOpenshell = (args: string[], opts?: { ignoreError?: boolean }) => string | null;

function makeDeepAgentsCodeAgent(): AgentDefinition {
  return loadAgent("langchain-deepagents-code");
}

function createAgentSetupContext(
  runCaptureOpenshell: RunCaptureOpenshell = vi.fn((_args: string[]) => ""),
) {
  return {
    step: vi.fn((_current: number, _total: number, _message: string) => undefined),
    runCaptureOpenshell,
    openshellShellCommand: vi.fn(() => "openshell sandbox connect deepagents-code"),
    openshellBinary: "/usr/bin/openshell",
    startRecordedStep: vi.fn(async (_stepName: string, _updates: Record<string, unknown>) => {
      return undefined;
    }),
    recordStepComplete: vi.fn(async (_stepName: string, _updates: Record<string, unknown>) => {
      return undefined;
    }),
    recordStepFailed: vi.fn(async (_stepName: string, _message: string | null) => {
      return undefined;
    }),
    skippedStepMessage: vi.fn((_stepName: string, _sandboxName: string) => undefined),
  };
}

describe("Deep Agents Code terminal onboard acceptance", () => {
  it("runs terminal smoke checks on fresh setup without gateway probes", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      calls.push(args.join(" "));
      const command = args[args.length - 1] || "";
      if (calls[calls.length - 1]?.includes("NEMOCLAW_AGENT_BINARY_CHECK")) {
        return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
      }
      if (command.includes("dcode --version")) {
        return "dcode 0.1.12\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
      }
      if (command.includes("/sandbox/.deepagents/config.toml")) {
        return "NEMOCLAW_DEEPAGENTS_CONFIG_OK\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
      }
      return "";
    });
    const context = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "deepagents-code",
      "model-x",
      "provider-x",
      makeDeepAgentsCodeAgent(),
      false,
      null,
      context,
    );

    expect(context.startRecordedStep).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.includes("NEMOCLAW_AGENT_SMOKE_EXIT"))).toHaveLength(2);
    expect(calls.some((call) => call.includes("nemoclaw-agent-smoke dcode --version"))).toBe(true);
    expect(calls.some((call) => call.includes("/sandbox/.deepagents/config.toml"))).toBe(true);
    expect(calls.some((call) => call.includes("curl"))).toBe(false);
  });

  it("resumes by verifying the binary while preserving terminal state ownership", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      calls.push(args.join(" "));
      return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
    });
    const context = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "deepagents-code",
      "model-x",
      "provider-x",
      makeDeepAgentsCodeAgent(),
      true,
      null,
      context,
    );

    expect(context.skippedStepMessage).toHaveBeenCalledWith("agent_setup", "deepagents-code");
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.startRecordedStep).not.toHaveBeenCalled();
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("NEMOCLAW_AGENT_BINARY_CHECK");
    expect(calls[0]).not.toContain("NEMOCLAW_AGENT_SMOKE_EXIT");
    expect(calls[0]).not.toContain("curl");
  });

  it("fails setup with an actionable terminal smoke error", async () => {
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      const call = args.join(" ");
      if (call.includes("NEMOCLAW_AGENT_BINARY_CHECK")) {
        return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
      }
      return "dcode provider route failed\nNEMOCLAW_AGENT_SMOKE_EXIT:42";
    });
    const context = createAgentSetupContext(runCaptureOpenshell);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);

    try {
      await expect(
        handleAgentSetup(
          "deepagents-code",
          "model-x",
          "provider-x",
          makeDeepAgentsCodeAgent(),
          false,
          null,
          context,
        ),
      ).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringContaining("terminal smoke command failed: dcode --version"),
    );
    expect(String(context.recordStepFailed.mock.calls[0]?.[1] ?? "")).toContain(
      "NEMOCLAW_AGENT_SMOKE_EXIT:42",
    );
  });
});
