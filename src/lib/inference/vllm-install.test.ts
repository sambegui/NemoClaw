// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectVllmProfile, installVllm } from "../../../dist/lib/inference/vllm";

const originalEnv = { ...process.env };
let binDir: string;

function installFakeCommand(name: string, body: string): void {
  const file = join(binDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "nemoclaw-vllm-test-bin-"));
  process.env = { ...originalEnv, PATH: `${binDir}:${originalEnv.PATH ?? ""}` };
  installFakeCommand("nvidia-smi", "echo NVIDIA GB300\n");
  installFakeCommand(
    "docker",
    `STATE_DIR=${JSON.stringify("__STATE_DIR__")}
STATE_DIR=${JSON.stringify(binDir)}
read_file() { [ -f "$STATE_DIR/$1" ] && cat "$STATE_DIR/$1"; }
case "$1" in
  pull) exit "$(read_file pull-exit || echo 0)" ;;
  run)
    if [ "$2" = "--rm" ]; then
      echo "Fetching 4 files: 25%|##"
      exit "$(read_file hf-exit || echo 0)"
    fi
    echo fake-container-id
    exit "$(read_file run-exit || echo 0)"
    ;;
  logs)
    if [ -f "$STATE_DIR/logs-output" ]; then cat "$STATE_DIR/logs-output"; else echo "Application startup complete"; fi
    exit "$(read_file logs-exit || echo 0)"
    ;;
  ps)
    if [ -f "$STATE_DIR/ps-output" ]; then cat "$STATE_DIR/ps-output"; else echo "nemoclaw-vllm"; fi
    ;;
  rm|stop) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(binDir, { recursive: true, force: true });
});

describe("installVllm", () => {
  it("returns false when an interactive user declines", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    await expect(
      installVllm(profile!, {
        hasImage: false,
        nonInteractive: false,
        promptFn: async () => "no",
      }),
    ).resolves.toEqual({ ok: false });
  });

  it("fails before pulling when docker is missing", async () => {
    const noDockerDir = mkdtempSync(join(tmpdir(), "nemoclaw-vllm-no-docker-"));
    try {
      const nvidiaSmi = join(noDockerDir, "nvidia-smi");
      writeFileSync(nvidiaSmi, "#!/bin/sh\necho NVIDIA GB300\n");
      chmodSync(nvidiaSmi, 0o755);
      process.env.PATH = noDockerDir;
      const profile = detectVllmProfile({ type: "nvidia" });
      await expect(
        installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: async () => "" }),
      ).resolves.toEqual({ ok: false });
    } finally {
      rmSync(noDockerDir, { recursive: true, force: true });
    }
  });

  it("fails when docker pull exits nonzero", async () => {
    writeFileSync(join(binDir, "pull-exit"), "17");
    const profile = detectVllmProfile({ type: "nvidia" });
    await expect(
      installVllm(profile!, { hasImage: false, nonInteractive: true, promptFn: async () => "" }),
    ).resolves.toEqual({ ok: false });
  });

  it("returns true after model download, container start, log readiness, and running check", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: async () => "" }),
    ).resolves.toEqual({ ok: true });
  });

  it("stops the container when readiness sees a fatal log marker", async () => {
    writeFileSync(join(binDir, "logs-output"), "CUDA out of memory\n");
    const profile = detectVllmProfile({ type: "nvidia" });
    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: async () => "" }),
    ).resolves.toEqual({ ok: false });
  });

  it("fails when the container exits after reporting ready", async () => {
    writeFileSync(join(binDir, "ps-output"), "");
    const profile = detectVllmProfile({ type: "nvidia" });
    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: async () => "" }),
    ).resolves.toEqual({ ok: false });
  });
});
