// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as sandboxState from "../state/sandbox";
import type { BackupResult } from "../state/sandbox";

export type SandboxBackupImpl = (sandboxName: string) => BackupResult;

export interface PreRecreateBackupOptions {
  sandboxName: string;
  backupImpl?: SandboxBackupImpl;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

export type PreRecreateBackupFailureKind = "none" | "partial" | "empty" | "threw";

// Copy-pasteable workaround surfaced on every backup failure so the operator has
// an in-product path forward instead of having to already know the env var.
// See issue #4758 (P-29 / PRR-43) and the recovery-command contract (case 5987921).
export const RECREATE_WITHOUT_BACKUP_HINT =
  "  To recreate without a backup (e.g. the container is already gone): " +
  "NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 nemoclaw onboard --resume";

export interface PreRecreateBackupResult {
  ok: boolean;
  backup: BackupResult | null;
  failureKind: PreRecreateBackupFailureKind;
  errorMessage?: string;
}

export function backupSandboxBeforeRecreate(
  opts: PreRecreateBackupOptions,
): PreRecreateBackupResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  const backupImpl = opts.backupImpl ?? sandboxState.backupSandboxState;
  try {
    const backup = backupImpl(opts.sandboxName);
    if (backup.success && backup.manifest?.backupPath) {
      log(
        `  ✓ State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
      );
      return { ok: true, backup, failureKind: "none" };
    }
    if (backup.backedUpDirs.length > 0 || backup.backedUpFiles.length > 0) {
      errorLog(
        `  Partial backup: ${backup.backedUpDirs.length} dirs / ${backup.backedUpFiles.length} files saved; ${backup.failedDirs.length} dirs / ${backup.failedFiles.length} files failed.`,
      );
      errorLog("  Aborting recreate — failed entries would be lost on delete.");
      errorLog(RECREATE_WITHOUT_BACKUP_HINT);
      return { ok: false, backup, failureKind: "partial" };
    }
    errorLog("  State backup failed — aborting recreate to prevent data loss.");
    errorLog(RECREATE_WITHOUT_BACKUP_HINT);
    return { ok: false, backup: null, failureKind: "empty" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog(`  State backup threw: ${message} — aborting recreate.`);
    errorLog(RECREATE_WITHOUT_BACKUP_HINT);
    return { ok: false, backup: null, failureKind: "threw", errorMessage: message };
  }
}

export function shouldSkipPreRecreateBackup(env: NodeJS.ProcessEnv): boolean {
  return env.NEMOCLAW_RECREATE_WITHOUT_BACKUP === "1";
}
