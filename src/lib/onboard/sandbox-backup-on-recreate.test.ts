// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  backupSandboxBeforeRecreate,
  shouldSkipPreRecreateBackup,
} from "../../../dist/lib/onboard/sandbox-backup-on-recreate";

function makeBackup(overrides: Record<string, unknown> = {}): unknown {
  return {
    success: true,
    backedUpDirs: ["workspace", "skills"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: { backupPath: "/tmp/backups/x", timestamp: "2026-05-25T00:00:00Z" },
    ...overrides,
  };
}

describe("backupSandboxBeforeRecreate", () => {
  it("returns ok with backup result on success", () => {
    const backup = makeBackup();
    const backupImpl = vi.fn().mockReturnValue(backup);
    const log = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl,
      log,
      errorLog: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(result.backup).toBe(backup);
    expect(result.failureKind).toBe("none");
    expect(backupImpl).toHaveBeenCalledWith("my-assistant");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("State backed up"));
  });

  it("treats partial backup as ok and warns", () => {
    const backup = makeBackup({
      success: false,
      backedUpDirs: ["workspace"],
      failedDirs: ["skills"],
      backedUpFiles: [],
      failedFiles: ["bad.bin"],
    });
    const log = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl: () => backup,
      log,
      errorLog: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(result.backup).toBe(backup);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Partial backup"));
  });

  it("returns ok:false with failureKind=empty when nothing was backed up", () => {
    const backup = makeBackup({
      success: false,
      backedUpDirs: [],
      failedDirs: ["workspace"],
      backedUpFiles: [],
      failedFiles: [],
    });
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl: () => backup,
      errorLog,
      log: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("empty");
    expect(result.backup).toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("aborting recreate"));
  });

  it("returns ok:false with failureKind=threw when backup throws", () => {
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl: () => {
        throw new Error("disk full");
      },
      errorLog,
      log: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("threw");
    expect(result.errorMessage).toBe("disk full");
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("State backup threw"));
  });
});

describe("shouldSkipPreRecreateBackup", () => {
  it("returns true when NEMOCLAW_RECREATE_WITHOUT_BACKUP=1", () => {
    expect(shouldSkipPreRecreateBackup({ NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1" })).toBe(true);
  });

  it("returns false for any other value", () => {
    expect(shouldSkipPreRecreateBackup({})).toBe(false);
    expect(shouldSkipPreRecreateBackup({ NEMOCLAW_RECREATE_WITHOUT_BACKUP: "0" })).toBe(false);
    expect(shouldSkipPreRecreateBackup({ NEMOCLAW_RECREATE_WITHOUT_BACKUP: "true" })).toBe(false);
  });
});
