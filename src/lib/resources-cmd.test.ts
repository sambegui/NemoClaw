// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendResourceFlags,
  getHardwareResources,
  loadResourceProfiles,
  printHardwareResources,
  resolveProfile,
  resolveResourceValue,
} from "../../dist/lib/resources-cmd.js";

const tempDirs: string[] = [];

function makeExecutable(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resources-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "openshell-fake");
  fs.writeFileSync(file, contents, { mode: 0o755 });
  return file;
}

describe("resources-cmd", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves percentage and absolute resource values", () => {
    expect(resolveResourceValue("25%", 16, "cpu")).toBe("4");
    expect(resolveResourceValue("50%", 8192, "memory")).toBe("4Gi");
    expect(resolveResourceValue("10%", 1024, "memory")).toBe("128Mi");
    expect(resolveResourceValue("750m", 16, "cpu")).toBe("750m");
    expect(resolveResourceValue("8Gi", 8192, "memory")).toBe("8Gi");
  });

  it("rejects malformed percentages before they reach OpenShell", () => {
    expect(() => resolveResourceValue("0%", 16, "cpu")).toThrow("integer between 1% and 100%");
    expect(() => resolveResourceValue("101%", 16, "cpu")).toThrow("integer between 1% and 100%");
    expect(() => resolveResourceValue("12.5%", 16, "cpu")).toThrow("integer between 1% and 100%");
  });

  it("resolves profiles against Kubernetes allocatable capacity when available", () => {
    const resolved = resolveProfile(
      {
        cpu_request: "50%",
        cpu_limit: "100%",
        memory_request: "25%",
        memory_limit: "50%",
      },
      {
        cpu: { cores: 16, model: "test-cpu", allocatable: "7500m" },
        memory: { totalMB: 32768, swapMB: 0, allocatableMB: 16384 },
        gpu: null,
        profiles: null,
      },
    );

    expect(resolved).toEqual({
      cpu_request: "3",
      cpu_limit: "7",
      memory_request: "4Gi",
      memory_limit: "8Gi",
    });
  });

  it("loads resource profiles from the blueprint", () => {
    const profiles = loadResourceProfiles();

    expect(profiles.developer).toEqual({
      cpu_request: "37%",
      cpu_limit: "75%",
      memory_request: "37%",
      memory_limit: "75%",
    });
    expect(profiles["game-developer"].cpu_limit).toBe("60%");
  });

  it("returns hardware resources and includes parsed blueprint profiles", () => {
    const hw = getHardwareResources();

    expect(hw.cpu.cores).toBeGreaterThan(0);
    expect(hw.cpu.model).toEqual(expect.any(String));
    expect(hw.memory.totalMB).toBeGreaterThan(0);
    expect(hw.profiles?.creator.cpu_request).toBe("25%");
  });

  it("prints JSON and returns the hardware object in JSON mode", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const hw = printHardwareResources(true);
      expect(hw.memory.totalMB).toBeGreaterThan(0);
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('"memory"'));
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("appends resolved OpenShell resource flags when supported", () => {
    const openshell = makeExecutable("#!/usr/bin/env sh\necho '--cpu-request --cpu-limit --memory-request --memory-limit'\n");
    const args = ["sandbox", "create"];

    const applied = appendResourceFlags(
      args,
      { cpu_request: "2", cpu_limit: "4", memory_request: "1Gi", memory_limit: "2Gi" },
      openshell,
    );

    expect(applied).toBe(true);
    expect(args).toEqual([
      "sandbox",
      "create",
      "--cpu-request",
      "2",
      "--cpu-limit",
      "4",
      "--memory-request",
      "1Gi",
      "--memory-limit",
      "2Gi",
    ]);
  });

  it("gracefully skips resource flags when OpenShell does not support them", () => {
    const openshell = makeExecutable("#!/usr/bin/env sh\necho 'usage: openshell sandbox create'\n");
    const args = ["sandbox", "create"];

    expect(
      appendResourceFlags(
        args,
        { cpu_request: "25%", cpu_limit: "50%", memory_request: "25%", memory_limit: "50%" },
        openshell,
      ),
    ).toBe(false);
    expect(args).toEqual(["sandbox", "create"]);
  });

  it("gracefully skips resource flags when profile resolution fails", () => {
    const openshell = makeExecutable("#!/usr/bin/env sh\necho '--cpu-request --cpu-limit'\n");
    const args = ["sandbox", "create"];

    expect(
      appendResourceFlags(
        args,
        { cpu_request: "bogus%", cpu_limit: "50%", memory_request: "25%", memory_limit: "50%" },
        openshell,
      ),
    ).toBe(false);
    expect(args).toEqual(["sandbox", "create"]);
  });
});
