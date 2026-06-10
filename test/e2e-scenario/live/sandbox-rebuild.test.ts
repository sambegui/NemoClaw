// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "../framework/e2e-test.ts";

// Manual sandbox rebuild proof. This creates and rebuilds a real sandbox, so it
// stays behind an explicit opt-in even when live E2E scenarios are enabled.

const DEFAULT_TIMEOUT_SECONDS = 1200;
const MARKER_FILE = "/sandbox/.openclaw/workspace/rebuild-marker.txt";
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const runSandboxRebuildTest = process.env.NEMOCLAW_E2E_SANDBOX_REBUILD === "1" ? test : test.skip;

type JsonObject = Record<string, unknown>;

function configuredTimeoutMs(): number {
  const raw = process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? String(DEFAULT_TIMEOUT_SECONDS);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("NEMOCLAW_E2E_TIMEOUT_SECONDS must be positive");
  }
  return parsed * 1000;
}

function requireEnv(name: string, expected?: string): void {
  const value = process.env[name];
  if (expected === undefined) {
    expect(value, `${name} is required`).toBeTruthy();
    return;
  }
  expect(value, `${name} must be ${expected}`).toBe(expected);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function asObject(value: unknown, label: string): JsonObject {
  expect(value, `${label} must be an object`).toBeTruthy();
  expect(typeof value, `${label} must be an object`).toBe("object");
  expect(Array.isArray(value), `${label} must not be an array`).toBe(false);
  return value as JsonObject;
}

async function readRegistry(): Promise<JsonObject> {
  return JSON.parse(await fs.readFile(REGISTRY_FILE, "utf8")) as JsonObject;
}

async function setRegistryAgentVersion(sandboxName: string, agentVersion: string): Promise<void> {
  const registry = await readRegistry();
  const sandboxes = asObject(registry.sandboxes, "registry.sandboxes");
  const sandbox = asObject(sandboxes[sandboxName], `registry.sandboxes.${sandboxName}`);
  sandbox.agentVersion = agentVersion;
  await fs.writeFile(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

async function registryAgentVersion(sandboxName: string): Promise<string | null> {
  const registry = await readRegistry();
  const sandboxes = asObject(registry.sandboxes, "registry.sandboxes");
  const sandbox = asObject(sandboxes[sandboxName], `registry.sandboxes.${sandboxName}`);
  const version = sandbox.agentVersion;
  return typeof version === "string" ? version : null;
}

async function listCredentialLeaks(rootDir: string): Promise<string[]> {
  const leaks: string[] = [];

  async function visit(current: string): Promise<void> {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const contents = await fs.readFile(target, "utf8");
      if (/nvapi-|sk-|Bearer /.test(contents)) {
        leaks.push(path.relative(rootDir, target));
      }
    }
  }

  await visit(rootDir);
  return leaks.sort();
}

runSandboxRebuildTest(
  "sandbox rebuild preserves workspace state and refreshes registry metadata",
  {
    timeout: configuredTimeoutMs() + 120_000,
  },
  async ({ artifacts, cleanup, host, sandbox }) => {
    const sandboxName = process.env.NEMOCLAW_SANDBOX_NAME || "e2e-rebuild";
    const markerContent = `REBUILD_E2E_${Date.now().toString()}`;
    const timeout = configuredTimeoutMs();

    await artifacts.writeJson("scenario.json", {
      id: "sandbox-rebuild",
      runner: "vitest",
      boundary: "host-sandbox-lifecycle",
      optIn: "NEMOCLAW_E2E_SANDBOX_REBUILD=1",
      sandboxName,
    });

    requireEnv("NVIDIA_API_KEY");
    requireEnv("NEMOCLAW_NON_INTERACTIVE", "1");

    cleanup.add(`destroy sandbox ${sandboxName}`, async () => {
      if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1") return;
      try {
        await host.nemoclaw([sandboxName, "destroy", "--yes"], {
          artifactName: "sandbox-rebuild-cleanup-destroy",
          inheritEnv: true,
          timeoutMs: 120_000,
        });
      } catch {
        // Cleanup is best-effort; the legacy script also ignored destroy errors.
      }
    });

    const onboard = await host.nemoclaw(
      [
        "onboard",
        "--sandbox-name",
        sandboxName,
        "--non-interactive",
        "--accept-third-party-software",
        "--recreate-sandbox",
      ],
      {
        artifactName: "sandbox-rebuild-onboard",
        inheritEnv: true,
        env: {
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_RECREATE_SANDBOX: "1",
        },
        timeoutMs: timeout,
      },
    );
    expect(onboard.exitCode, `onboard failed\n${onboard.stderr}`).toBe(0);

    const status = await host.nemoclaw([sandboxName, "status"], {
      artifactName: "sandbox-rebuild-status",
      inheritEnv: true,
      timeoutMs: 60_000,
    });
    await artifacts.writeText("status-output.txt", `${status.stdout}\n${status.stderr}`);

    const writeMarker = await sandbox.exec(
      sandboxName,
      [
        "sh",
        "-c",
        `mkdir -p ${shellQuote(path.dirname(MARKER_FILE))} && printf '%s\\n' ${shellQuote(markerContent)} > ${shellQuote(MARKER_FILE)}`,
      ],
      { artifactName: "sandbox-rebuild-write-marker", inheritEnv: true, timeoutMs: 60_000 },
    );
    expect(writeMarker.exitCode, `write marker failed\n${writeMarker.stderr}`).toBe(0);

    const markerBefore = await sandbox.exec(sandboxName, ["cat", MARKER_FILE], {
      artifactName: "sandbox-rebuild-marker-before",
      inheritEnv: true,
      timeoutMs: 60_000,
    });
    expect(markerBefore.exitCode, `read marker failed\n${markerBefore.stderr}`).toBe(0);
    expect(markerBefore.stdout.trim()).toBe(markerContent);

    await setRegistryAgentVersion(sandboxName, "0.0.1");
    await artifacts.writeJson("registry-stale-version-proof.json", {
      sandboxName,
      agentVersion: await registryAgentVersion(sandboxName),
    });

    const connect = await host.command(
      "bash",
      ["-lc", `timeout 10 nemoclaw ${shellQuote(sandboxName)} connect <<<"exit"`],
      {
        artifactName: "sandbox-rebuild-connect-stale-warning",
        inheritEnv: true,
        timeoutMs: 30_000,
      },
    );
    if (!/rebuild/i.test(`${connect.stdout}\n${connect.stderr}`)) {
      await artifacts.writeText(
        "connect-stale-warning-note.txt",
        "No rebuild warning was observed; legacy bash treated this as acceptable when the sandbox is not live.\n",
      );
    }

    const rebuild = await host.nemoclaw([sandboxName, "rebuild", "--yes"], {
      artifactName: "sandbox-rebuild-run",
      inheritEnv: true,
      timeoutMs: timeout,
    });
    expect(rebuild.exitCode, `rebuild failed\n${rebuild.stderr}`).toBe(0);

    const markerAfter = await sandbox.exec(sandboxName, ["cat", MARKER_FILE], {
      artifactName: "sandbox-rebuild-marker-after",
      inheritEnv: true,
      timeoutMs: 60_000,
    });
    expect(markerAfter.exitCode, `read restored marker failed\n${markerAfter.stderr}`).toBe(0);
    expect(markerAfter.stdout.trim()).toBe(markerContent);

    const updatedVersion = await registryAgentVersion(sandboxName);
    expect(updatedVersion, "registry agentVersion should be present after rebuild").toBeTruthy();
    expect(updatedVersion, "registry agentVersion should be refreshed after rebuild").not.toBe(
      "0.0.1",
    );

    const backupDir = path.join(os.homedir(), ".nemoclaw", "rebuild-backups", sandboxName);
    const leaks = await listCredentialLeaks(backupDir);
    expect(leaks, "backup JSON files must not contain credential-shaped values").toEqual([]);
  },
);
