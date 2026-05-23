// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  looksLikeForwardPortConflict,
  runDetachedForwardStartWithDiagnostics,
  runDetachedForwardStartWithPortReleaseRetries,
} from "../../../dist/lib/onboard/forward-start";

// Build an `openshell forward list`-shaped output for the given live entries.
// Mirrors the column layout (SANDBOX BIND PORT PID STATUS) that
// `getOccupiedPorts` parses, so the helper recognises the forward as live.
function forwardListWith(entries: Array<{ sandbox: string; port: number; status?: string }>): string {
  const header = "SANDBOX   BIND        PORT   PID    STATUS";
  const rows = entries.map(
    (e) => `${e.sandbox}  127.0.0.1   ${e.port}   1234   ${e.status ?? "running"}`,
  );
  return [header, ...rows].join("\n");
}

describe("runDetachedForwardStartWithDiagnostics", () => {
  it("returns ok as soon as the forward appears in the list", () => {
    const fetchList = vi
      .fn()
      .mockReturnValueOnce(forwardListWith([])) // first poll: nothing yet
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.pid).toBe(42);
    expect(spawn).toHaveBeenCalledTimes(1);
    // First poll missed → one sleep before the second poll observed the entry.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("ignores entries that belong to a different sandbox", () => {
    const fetchList = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "other-sandbox", port: 18789 }]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 50, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("reports timeout when the forward never appears", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.diagnostic).toMatch(/forward did not appear in list within 30ms/);
  });

  it("surfaces spawn errors immediately without polling", () => {
    const fetchList = vi.fn();
    const spawn = vi.fn().mockReturnValue({ error: new Error("ENOENT: openshell not found") });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn-error");
    expect(result.diagnostic).toMatch(/ENOENT/);
    expect(fetchList).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("surfaces async spawn errors fired after the runner returned", () => {
    const fetchList = vi.fn().mockReturnValue("");
    let asyncErrorCallback: ((err: Error) => void) | undefined;
    const spawn = vi.fn().mockImplementation((_stdio, onAsyncError) => {
      asyncErrorCallback = onAsyncError;
      return { pid: 4242 };
    });
    // The sleep stub is the only synchronous yield point in the helper's
    // poll loop. Simulate Node's `error` event firing during that pause so
    // the next iteration observes `asyncSpawnError` and returns spawn-error.
    let sleepCalls = 0;
    const sleep = vi.fn().mockImplementation(() => {
      sleepCalls += 1;
      if (sleepCalls === 1 && asyncErrorCallback) {
        asyncErrorCallback(new Error("spawn ENOENT"));
      }
    });

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 1_000, pollIntervalMs: 5, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn-error");
    expect(result.diagnostic).toMatch(/spawn ENOENT/);
  });

  it("invokes onProgress while waiting for the forward to appear", () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const fetchList = vi.fn().mockReturnValue("");
      const spawn = vi.fn().mockReturnValue({ pid: 42 });
      const sleep = vi.fn().mockImplementation((ms) => {
        now += ms;
      });
      const onProgress = vi.fn();

      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        {
          overallTimeoutMs: 120_000,
          pollIntervalMs: 1_000,
          sleepMs: sleep,
          onProgress,
          progressIntervalMs: 30_000,
        },
      );

      expect(result.ok).toBe(false);
      expect(onProgress).toHaveBeenCalled();
      const calls = onProgress.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls[0][0].elapsedMs).toBeGreaterThanOrEqual(30_000);
      expect(result.diagnostic).toMatch(/forward did not appear in list within 120000ms/);
      expect(result.diagnostic).toMatch(/last forward list: <empty>/);
    } finally {
      Date.now = realNow;
    }
  });

  it("surfaces persistent fetchForwardList failures in the timeout diagnostic", () => {
    const fetchList = vi.fn().mockImplementation(() => {
      throw new Error("gateway transport: connection refused");
    });
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.diagnostic).toMatch(/openshell forward list failed/);
    expect(result.diagnostic).toMatch(/connection refused/);
  });

  it("treats fetchForwardList exceptions as transient and keeps polling", () => {
    const fetchList = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("gateway not reachable yet");
      })
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(true);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });
});

describe("runDetachedForwardStartWithPortReleaseRetries", () => {
  it("retries after a port-conflict diagnostic, then succeeds", () => {
    const fetchList = vi
      .fn()
      .mockReturnValueOnce(forwardListWith([])) // first attempt: never appears
      .mockReturnValueOnce(forwardListWith([])) // (timeout settles)
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const beforeRetry = vi.fn();
    // First spawn surfaces a port-conflict in its diagnostic synthesised via
    // an Error message; the second spawn succeeds and the forward appears.
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ error: new Error("EADDRINUSE: address already in use") })
      .mockReturnValueOnce({ pid: 99 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithPortReleaseRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      3,
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(true);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the failure does not look like a port conflict", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const beforeRetry = vi.fn();
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithPortReleaseRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      3,
      { overallTimeoutMs: 20, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after maxRetries even if conflict diagnostics persist", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const beforeRetry = vi.fn();
    const spawn = vi
      .fn()
      .mockReturnValue({ error: new Error("EADDRINUSE: address already in use") });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithPortReleaseRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      2,
      { overallTimeoutMs: 20, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(beforeRetry).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("looksLikeForwardPortConflict", () => {
  it("matches the common port-in-use signals", () => {
    expect(looksLikeForwardPortConflict("listen tcp 0.0.0.0:18789: bind: address already in use")).toBe(
      true,
    );
    expect(looksLikeForwardPortConflict("EADDRINUSE")).toBe(true);
    expect(looksLikeForwardPortConflict("port 18789 in use")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(looksLikeForwardPortConflict("transport: connection refused")).toBe(false);
    expect(looksLikeForwardPortConflict("")).toBe(false);
  });
});
