// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that gateway-reuse waits for the host-level HTTP endpoint to start
// returning 2xx (or 401) before declaring the gateway reusable. Without this,
// a gateway whose container is up but whose upstream is still warming up
// (e.g. immediately after a Docker daemon restart) gets reused with stale
// CLI metadata, leading to "Connection refused" later in onboard.
//
// Also verifies the Docker-state-`unknown` branch stays non-destructive
// (#2020 invariant) — when the docker daemon is itself flaky, destroying and
// recreating the gateway cannot succeed anyway.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3258
// Regression of: https://github.com/NVIDIA/NemoClaw/issues/2020

import http from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import { type AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const onboardModule = require("../dist/lib/onboard.js") as {
  getGatewayReuseHealthWaitConfig: () => { count: number; interval: number };
  isGatewayHttpReady: (timeoutMs?: number, url?: string) => Promise<boolean>;
  waitForGatewayHttpReady: (opts?: {
    probe?: () => Promise<boolean>;
    sleeper?: (seconds: number) => void;
    maxAttempts?: number;
    intervalSeconds?: number;
  }) => Promise<boolean>;
};
const { getGatewayReuseHealthWaitConfig, isGatewayHttpReady, waitForGatewayHttpReady } =
  onboardModule;

/** Spin up a tiny HTTP server that returns the given status code, return its URL. */
async function startStatusServer(statusCode: number): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.statusCode = statusCode;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const ROOT = path.resolve(import.meta.dirname, "..");

describe("getGatewayReuseHealthWaitConfig (#3258)", () => {
  const originalCount = process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT;
  const originalInterval = process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL;

  beforeEach(() => {
    delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT;
    delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL;
  });

  afterEach(() => {
    if (originalCount === undefined) delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT;
    else process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT = originalCount;
    if (originalInterval === undefined) delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL;
    else process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL = originalInterval;
  });

  it("defaults to 6 polls × 5s when no env overrides are set", () => {
    expect(getGatewayReuseHealthWaitConfig()).toEqual({ count: 6, interval: 5 });
  });

  it("respects NEMOCLAW_REUSE_HEALTH_POLL_COUNT", () => {
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT = "12";
    expect(getGatewayReuseHealthWaitConfig().count).toBe(12);
  });

  it("respects NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL", () => {
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL = "2";
    expect(getGatewayReuseHealthWaitConfig().interval).toBe(2);
  });

  it("falls back to defaults when env values are non-finite", () => {
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT = "not-a-number";
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL = "";
    expect(getGatewayReuseHealthWaitConfig()).toEqual({ count: 6, interval: 5 });
  });
});

describe("isGatewayHttpReady status-code semantics (#3258)", () => {
  it("returns true for 200", async () => {
    const server = await startStatusServer(200);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns true for 401 (device-auth gate enabled, gateway is alive)", async () => {
    const server = await startStatusServer(401);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns false for 502 (gateway up but k3s upstream still warming)", async () => {
    const server = await startStatusServer(502);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns false for 404 (root not handled — not a healthy signal)", async () => {
    const server = await startStatusServer(404);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns false for 403", async () => {
    const server = await startStatusServer(403);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns false on connection refused", async () => {
    // 127.0.0.1:1 is reserved and not in use — get connection refused.
    expect(await isGatewayHttpReady(2000, "http://127.0.0.1:1/")).toBe(false);
  });
});

describe("waitForGatewayHttpReady (#3258)", () => {
  it("returns true on the first probe call when the gateway is already responding", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return true;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 6,
      intervalSeconds: 5,
    });
    expect(result).toBe(true);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries until the probe passes, sleeping between attempts", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return calls >= 3;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 6,
      intervalSeconds: 5,
    });
    expect(result).toBe(true);
    expect(calls).toBe(3);
    // Sleeps happen between attempts only — two failures → two sleeps before the success.
    expect(sleeps).toEqual([5, 5]);
  });

  it("returns false when the probe never passes within the budget", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return false;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 4,
      intervalSeconds: 3,
    });
    expect(result).toBe(false);
    expect(calls).toBe(4);
    // No trailing sleep after the final failed attempt.
    expect(sleeps).toEqual([3, 3, 3]);
  });

  it("respects an attempt count of 1 — single probe, no sleeps", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return false;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 1,
      intervalSeconds: 5,
    });
    expect(result).toBe(false);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("gateway-reuse HTTP readiness wait integration (#3258)", () => {
  const content = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");

  it("preflight uses host-level HTTP probe, not docker exec", () => {
    const preflightStart = content.indexOf("async function preflight(");
    const preflightEnd = content.indexOf("async function startGatewayWithOptions(");
    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(preflightEnd).toBeGreaterThan(preflightStart);
    const preflightSection = content.slice(preflightStart, preflightEnd);
    expect(preflightSection).toMatch(/await waitForGatewayHttpReady\(\)/);
  });

  it("main onboard uses host-level HTTP probe, not docker exec", () => {
    const onboardSection = content.slice(content.indexOf("async function onboard("));
    expect(onboardSection).toMatch(/await waitForGatewayHttpReady\(\)/);
  });

  it("isGatewayHttpReady probes 127.0.0.1:GATEWAY_PORT and only accepts an explicit alive whitelist", () => {
    expect(content).toMatch(/`http:\/\/127\.0\.0\.1:\$\{GATEWAY_PORT\}\/`/);
    // Mirrors verify-deployment.ts: only 200 (serving) and 401 (device-auth
    // gate enabled, gateway is running) count as alive. Everything else —
    // including 404, 403, 502, transport errors — is "not ready".
    expect(content).toMatch(/GATEWAY_HTTP_ALIVE_CODES = new Set<number>\(\[200, 401\]\)/);
    expect(content).toMatch(/GATEWAY_HTTP_ALIVE_CODES\.has\(code\)/);
  });

  it("downgrades reuse state to 'missing' when container is running and HTTP never recovers", () => {
    // Both reuse sites must follow the pattern: containerState === "running"
    // path → wait for HTTP → on failure, destroy and downgrade.
    const downgrades = content.match(
      /!\(await waitForGatewayHttpReady\(\)\)[\s\S]{0,1500}?destroyGateway\(\)[\s\S]{0,300}?gatewayReuseState = "missing"/g,
    );
    expect(downgrades).toBeTruthy();
    if (!downgrades) {
      throw new Error('Expected !(await waitForGatewayHttpReady) → destroyGateway → "missing" downgrade');
    }
    expect(downgrades.length).toBeGreaterThanOrEqual(2);
  });

  it("startGatewayWithOptions health-poll requires HTTP readiness alongside CLI metadata (#3258)", () => {
    // After the reuse gate falls through and the start path runs, the
    // post-start health-poll loop must require BOTH `isGatewayHealthy(...)`
    // (CLI metadata) AND host HTTP readiness before declaring success.
    // The CLI metadata can be stale-but-healthy while the upstream is still
    // warming up; the HTTP probe rules that out.
    const startGwIdx = content.indexOf("async function startGatewayWithOptions(");
    expect(startGwIdx).toBeGreaterThanOrEqual(0);
    const startGwSection = content.slice(startGwIdx, startGwIdx + 8000);
    // The single-loop success gate must AND the two probes together.
    expect(startGwSection).toMatch(
      /isGatewayHealthy\([^)]*\) && \(await isGatewayHttpReady\(\)\)/,
    );
  });

  it("startGatewayWithOptions HTTP-gates the final reuse decision (#3258)", () => {
    // The early-return reuse path inside startGatewayWithOptions must also
    // probe HTTP readiness — otherwise a fresh OpenShell CLI snapshot can
    // re-trigger "Reusing existing gateway" with stale-but-CLI-healthy
    // metadata, bypassing the upstream HTTP wait performed in onboard().
    const startGwIdx = content.indexOf("async function startGatewayWithOptions(");
    expect(startGwIdx).toBeGreaterThanOrEqual(0);
    const startGwSection = content.slice(startGwIdx, startGwIdx + 4000);
    // Within the isGatewayHealthy(...) reuse branch, isGatewayHttpReady must
    // be awaited before "Reusing existing gateway" is logged.
    expect(startGwSection).toMatch(
      /isGatewayHealthy\([\s\S]*?await isGatewayHttpReady\(\)[\s\S]*?Reusing existing gateway/,
    );
  });

  it("downgrades reuse state to 'missing' in unknown+HTTP-fail without destroying the gateway", () => {
    // Per #2020 we must not destroyGateway() in the unknown branch (Docker may
    // be unavailable; recreate cannot succeed). But per #3258 we must not let
    // cached "healthy" carry through either. Compromise: set state to
    // "missing" so the regular gateway-start path runs and surfaces a clearer
    // error if it can't proceed.
    const unknownBlockRegex =
      /containerState === "unknown"[\s\S]*?(?=\}\s*else if \(!\(await waitForGatewayHttpReady)/g;
    const unknownBlocks = content.match(unknownBlockRegex);
    expect(unknownBlocks).toBeTruthy();
    if (!unknownBlocks) {
      throw new Error('Expected containerState === "unknown" branches followed by HTTP-wait fallthrough');
    }
    expect(unknownBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of unknownBlocks) {
      // No destructive cleanup inside the unknown branch.
      expect(block).not.toMatch(/destroyGateway\(\)/);
      expect(block).not.toMatch(/registry\.clearAll\(\)/);
      // But the HTTP-fail sub-branch must downgrade reuse state.
      expect(block).toMatch(/gatewayReuseState = "missing"/);
    }
  });
});
