// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import ResourcesCommand from "../../../dist/lib/commands/resources.js";

const rootDir = process.cwd();

describe("ResourcesCommand", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the hardware resource object in JSON mode", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await ResourcesCommand.run(["--json"], rootDir);
      expect(result).toEqual(expect.objectContaining({
        cpu: expect.objectContaining({ cores: expect.any(Number), model: expect.any(String) }),
        memory: expect.objectContaining({ totalMB: expect.any(Number), swapMB: expect.any(Number) }),
      }));
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('"cpu"'));
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("prints human-readable output without returning data in text mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(ResourcesCommand.run([], rootDir)).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith("  Hardware Resources");
    } finally {
      logSpy.mockRestore();
    }
  });
});
