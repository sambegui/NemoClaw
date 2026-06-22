// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "update-hermes-agent.sh");
const TARGET_TAG = "v2026.6.19";

describe("scripts/update-hermes-agent.sh", () => {
  it("keeps installed-copy scanning opt-in unless rebuild needs it", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-home-"));
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "agents",
      "hermes",
      "Dockerfile.base",
    );
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, "ARG HERMES_VERSION=v2026.6.5\n");

    const run = (...args: string[]) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      });

    try {
      const defaultCheck = run();
      expect(defaultCheck.status).toBe(0);
      expect(defaultCheck.stdout).toContain("Installed-copy scan skipped");

      const explicitScan = run("--update-installed-copies");
      expect(explicitScan.status).toBe(1);
      expect(explicitScan.stdout).toContain("STALE: installed copy");
      expect(explicitScan.stdout).toContain(installedDockerfile);

      const rebuildCheck = run("--rebuild");
      expect(rebuildCheck.status).toBe(1);
      expect(rebuildCheck.stdout).toContain("STALE: installed copy");
      expect(rebuildCheck.stdout).toContain(installedDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
