// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTracer, resetTracerForTesting, TRACE_DIR_ENV, TRACE_FILE_ENV } from "./profiling";

class FakeClock {
  private index = 0;

  constructor(private readonly times: number[]) {}

  nowMicroseconds(): number {
    const time = this.times[this.index];
    this.index += 1;
    return time ?? this.times[this.times.length - 1] ?? 0;
  }
}

describe("profiling tracer", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    delete process.env[TRACE_FILE_ENV];
    delete process.env[TRACE_DIR_ENV];
    resetTracerForTesting();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("is a no-op unless tracing is enabled", () => {
    const tracer = createTracer({ enabled: false, clock: new FakeClock([1000, 2000]) });

    expect(tracer.enabled).toBe(false);
    const span = tracer.startSpan("onboard.total");
    span.end();

    expect(tracer.toChromeTrace()).toEqual({ traceEvents: [] });
  });

  it("records complete spans in Chrome trace event format", () => {
    const tracer = createTracer({
      enabled: true,
      clock: new FakeClock([1000, 6000]),
      pid: 42,
      tid: 7,
    });

    tracer.startSpan("onboard.gateway", { sandbox: "demo" }).end({ ok: true });

    expect(tracer.toChromeTrace()).toEqual({
      traceEvents: [
        {
          name: "onboard.gateway",
          cat: "nemoclaw",
          ph: "X",
          ts: 1000,
          dur: 5000,
          pid: 42,
          tid: 7,
          args: { sandbox: "demo", ok: true },
        },
      ],
    });
  });

  it("redacts likely secrets from trace args", () => {
    const tracer = createTracer({ enabled: true, clock: new FakeClock([1000, 6000]) });

    tracer
      .startSpan("onboard.secret", {
        token: "nvapi-1234567890abcdef",
        url: "https://example.test/v1?api_key=sk-1234567890abcdef&model=ok",
        stderr: "Authorization: Bearer ghp_1234567890abcdefghijklmnop",
      })
      .end();

    const serialized = JSON.stringify(tracer.toChromeTrace());
    expect(serialized).not.toContain("nvapi-1234567890abcdef");
    expect(serialized).not.toContain("sk-1234567890abcdef");
    expect(serialized).not.toContain("ghp_1234567890abcdefghijklmnop");
    expect(tracer.toChromeTrace().traceEvents[0].args).toMatchObject({
      token: "[REDACTED]",
      url: "https://example.test/v1?api_key=[REDACTED]&model=ok",
      stderr: "Authorization: Bearer [REDACTED]",
    });
  });

  it("allows nested spans without flattening their timestamps", () => {
    const tracer = createTracer({
      enabled: true,
      clock: new FakeClock([1000, 2000, 4000, 7000]),
      pid: 42,
      tid: 0,
    });

    const outer = tracer.startSpan("onboard.total");
    const inner = tracer.startSpan("onboard.gateway");
    inner.end();
    outer.end();

    expect(tracer.toChromeTrace().traceEvents).toEqual([
      expect.objectContaining({ name: "onboard.gateway", ts: 2000, dur: 2000 }),
      expect.objectContaining({ name: "onboard.total", ts: 1000, dur: 6000 }),
    ]);
  });

  it("withSpan ends spans when the wrapped function throws", () => {
    const tracer = createTracer({ enabled: true, clock: new FakeClock([10, 15]) });

    expect(() =>
      tracer.withSpan("onboard.failure", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(tracer.toChromeTrace().traceEvents).toEqual([
      expect.objectContaining({
        name: "onboard.failure",
        ts: 10,
        dur: 5,
        args: { error: "boom" },
      }),
    ]);
  });

  it("withSpan keeps async spans open until the promise settles", async () => {
    const tracer = createTracer({ enabled: true, clock: new FakeClock([10, 15]) });

    await tracer.withSpan("onboard.async", async () => "ok");

    expect(tracer.toChromeTrace().traceEvents).toEqual([
      expect.objectContaining({ name: "onboard.async", ts: 10, dur: 5 }),
    ]);
  });

  it("withSpan records async rejection details before rethrowing", async () => {
    const tracer = createTracer({ enabled: true, clock: new FakeClock([10, 15]) });

    await expect(
      tracer.withSpan("onboard.async.failure", async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");

    expect(tracer.toChromeTrace().traceEvents).toEqual([
      expect.objectContaining({
        name: "onboard.async.failure",
        ts: 10,
        dur: 5,
        args: { error: "async boom" },
      }),
    ]);
  });

  it("ignores duplicate span end calls", () => {
    const tracer = createTracer({ enabled: true, clock: new FakeClock([10, 15, 100]) });
    const span = tracer.startSpan("onboard.once");

    span.end();
    span.end();

    expect(tracer.toChromeTrace().traceEvents).toHaveLength(1);
    expect(tracer.toChromeTrace().traceEvents[0]).toMatchObject({ dur: 5 });
  });

  it("writes trace data to the configured file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-"));
    tempDirs.push(tempDir);
    const traceFile = path.join(tempDir, "trace.json");
    const tracer = createTracer({ enabled: true, traceFile, clock: new FakeClock([100, 250]) });

    tracer.startSpan("onboard.write").end();
    tracer.flush();

    expect(JSON.parse(fs.readFileSync(traceFile, "utf8"))).toEqual({
      traceEvents: [expect.objectContaining({ name: "onboard.write", ph: "X", ts: 100, dur: 150 })],
    });
  });

  it("uses NEMOCLAW_TRACE_DIR to allocate a per-process trace file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-dir-"));
    tempDirs.push(tempDir);
    process.env[TRACE_DIR_ENV] = tempDir;
    const tracer = createTracer({ clock: new FakeClock([100, 250]) });

    tracer.startSpan("onboard.dir").end();
    tracer.flush();

    const files = fs.readdirSync(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^nemoclaw-trace-.*\.json$/);
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, files[0]), "utf8"))).toEqual({
      traceEvents: [expect.objectContaining({ name: "onboard.dir", ph: "X", ts: 100, dur: 150 })],
    });
  });
});
