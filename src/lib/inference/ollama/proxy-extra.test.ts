// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const PROXY_DIST_PATH = require.resolve("../../../../dist/lib/inference/ollama/proxy");
const RUNNER_DIST_PATH = require.resolve("../../../../dist/lib/runner");
const CHILD_PROCESS_ID = "child_process";

type ProxyModule = typeof import("../../../../dist/lib/inference/ollama/proxy");

function loadProxyWithMocks({
  runCapture = vi.fn(() => ""),
  run = vi.fn(),
  spawnSync = vi.fn(() => ({ status: 0, stdout: "200" })),
}: {
  runCapture?: ReturnType<typeof vi.fn>;
  run?: ReturnType<typeof vi.fn>;
  spawnSync?: ReturnType<typeof vi.fn>;
} = {}): { proxy: ProxyModule; restore: () => void; mocks: { runCapture: typeof runCapture; run: typeof run; spawnSync: typeof spawnSync } } {
  const runner = require(RUNNER_DIST_PATH);
  const childProcess = require(CHILD_PROCESS_ID);
  const originals = {
    runCapture: runner.runCapture,
    run: runner.run,
    spawnSync: childProcess.spawnSync,
  };
  delete require.cache[PROXY_DIST_PATH];
  runner.runCapture = runCapture;
  runner.run = run;
  childProcess.spawnSync = spawnSync;
  const proxy = require(PROXY_DIST_PATH) as ProxyModule;
  return {
    proxy,
    mocks: { runCapture, run, spawnSync },
    restore: () => {
      delete require.cache[PROXY_DIST_PATH];
      runner.runCapture = originals.runCapture;
      runner.run = originals.run;
      childProcess.spawnSync = originals.spawnSync;
    },
  };
}

afterEach(() => {
  delete require.cache[PROXY_DIST_PATH];
  delete process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT;
  vi.restoreAllMocks();
});

describe("ollama proxy helpers", () => {
  it("uses default pull timeout for unset, empty, invalid, or non-positive values", () => {
    const { proxy, restore } = loadProxyWithMocks();
    try {
      expect(proxy.getOllamaPullTimeoutMs()).toBe(30 * 60 * 1000);
      process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT = "";
      expect(proxy.getOllamaPullTimeoutMs()).toBe(30 * 60 * 1000);
      process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT = "bogus";
      expect(proxy.getOllamaPullTimeoutMs()).toBe(30 * 60 * 1000);
      process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT = "0";
      expect(proxy.getOllamaPullTimeoutMs()).toBe(30 * 60 * 1000);
    } finally {
      restore();
    }
  });

  it("converts positive pull timeout seconds to milliseconds", () => {
    process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT = "12.9";
    const { proxy, restore } = loadProxyWithMocks();
    try {
      expect(proxy.getOllamaPullTimeoutMs()).toBe(12_900);
    } finally {
      restore();
    }
  });

  it("unloads each running Ollama model with keep_alive zero", () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ models: [{ name: "qwen" }, {}, { name: "llama" }] }) })
      .mockReturnValue({ status: 0, stdout: "" });
    const { proxy, restore } = loadProxyWithMocks({ spawnSync });
    try {
      proxy.unloadOllamaModels();
      expect(spawnSync).toHaveBeenCalledTimes(3);
      const firstGenerateArgs = spawnSync.mock.calls[1][1] as string[];
      const secondGenerateArgs = spawnSync.mock.calls[2][1] as string[];
      expect(JSON.parse(firstGenerateArgs[firstGenerateArgs.indexOf("-d") + 1])).toEqual({
        model: "qwen",
        keep_alive: 0,
      });
      expect(JSON.parse(secondGenerateArgs[secondGenerateArgs.indexOf("-d") + 1])).toEqual({
        model: "llama",
        keep_alive: 0,
      });
    } finally {
      restore();
    }
  });

  it("ignores ps failures and malformed ps output while unloading", () => {
    for (const firstResult of [
      { status: 7, stdout: "" },
      { status: 0, stdout: "not-json" },
    ]) {
      const spawnSync = vi.fn().mockReturnValue(firstResult);
      const { proxy, restore } = loadProxyWithMocks({ spawnSync });
      try {
        expect(() => proxy.unloadOllamaModels()).not.toThrow();
        expect(spawnSync).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    }
  });

  it("reports healthy when the HTTP probe succeeds even without a matching PID", () => {
    const runCapture = vi.fn((cmd: string[]) => (cmd[0] === "curl" ? "{}" : ""));
    const { proxy, mocks, restore } = loadProxyWithMocks({ runCapture });
    try {
      expect(proxy.isProxyHealthy()).toBe(true);
      expect(mocks.runCapture).toHaveBeenCalledWith(
        expect.arrayContaining(["curl", "-sf"]),
        { ignoreError: true },
      );
    } finally {
      restore();
    }
  });

  it("falls back to process identity when the HTTP probe fails", () => {
    const runCapture = vi.fn((cmd: string[]) => {
      if (cmd[0] === "ps") return "node /tmp/ollama-auth-proxy.js";
      return "";
    });
    const { proxy, restore } = loadProxyWithMocks({ runCapture });
    try {
      // No persisted PID is present in the test home, so this should stay false.
      expect(proxy.isProxyHealthy()).toBe(false);
    } finally {
      restore();
    }
  });
});
