// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCurlProbe } from "./adapters/http/probe";
import {
  addTraceEvent,
  flushTrace,
  resetTraceForTests,
  sanitizeTraceAttributes,
  withTraceSpan,
  type TraceArtifact,
} from "./trace";

function withTraceFile<T>(fn: (traceFile: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-test-"));
  const traceFile = path.join(tmpDir, "trace.json");
  process.env.NEMOCLAW_TRACE_FILE = traceFile;
  resetTraceForTests();
  return fn(traceFile);
}

afterEach(() => {
  delete process.env.NEMOCLAW_TRACE_FILE;
  delete process.env.NEMOCLAW_TRACE_DIR;
  resetTraceForTests();
});

describe("onboard trace artifacts", () => {
  it("writes OpenTelemetry-style spans and a slowest-span summary", () => {
    withTraceFile((traceFile) => {
      withTraceSpan("nemoclaw.onboard.phase.gateway", { provider: "nvidia-prod" }, () => {
        addTraceEvent("ready", { attempt: 1 });
      });

      expect(flushTrace()).toBe(traceFile);
      const artifact = JSON.parse(fs.readFileSync(traceFile, "utf8")) as TraceArtifact;
      const spans = artifact.resource_spans[0].scope_spans[0].spans;

      expect(artifact.resource_spans[0].scope_spans[0].scope.name).toBe("nemoclaw.onboard");
      expect(spans).toHaveLength(1);
      expect(spans[0].trace_id).toBe(artifact.summary.trace_id);
      expect(spans[0].span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(spans[0].duration_ms).toBeGreaterThanOrEqual(0);
      expect(spans[0].events[0]).toMatchObject({
        name: "ready",
        attributes: { attempt: 1 },
      });
      expect(artifact.summary.slowest_spans[0].name).toBe("nemoclaw.onboard.phase.gateway");
    });
  });

  it("redacts secret-like metadata before writing artifacts", () => {
    withTraceFile((traceFile) => {
      withTraceSpan(
        "nemoclaw.inference.validation_probe",
        {
          api_key: "nvapi-secret-value",
          authorization: "Bearer sk-secret-value",
          endpoint_url: "https://user:pass@example.test/v1?token=secret",
        },
        () => undefined,
      );

      flushTrace();
      const text = fs.readFileSync(traceFile, "utf8");

      expect(text).not.toContain("nvapi-secret-value");
      expect(text).not.toContain("sk-secret-value");
      expect(text).not.toContain("user:pass");
      expect(text).not.toContain("token=secret");
      expect(text).toContain("<REDACTED>");
    });
  });

  it("sanitizes curl probe URLs and records status metadata", () => {
    withTraceFile((traceFile) => {
      const result = runCurlProbe(
        [
          "-sS",
          "-H",
          "Authorization: Bearer should-not-appear",
          "https://example.test/v1/chat/completions?key=secret",
        ],
        {
          spawnSyncImpl: () =>
            ({
              status: 0,
              stdout: "200",
              stderr: "",
              error: undefined,
            }) as never,
        },
      );

      expect(result.ok).toBe(true);
      flushTrace();
      const text = fs.readFileSync(traceFile, "utf8");
      const artifact = JSON.parse(text) as TraceArtifact;
      const span = artifact.resource_spans[0].scope_spans[0].spans.find(
        (entry) => entry.name === "nemoclaw.inference.curl_probe",
      );

      expect(text).not.toContain("should-not-appear");
      expect(text).not.toContain("key=secret");
      expect(span?.attributes["http.url"]).toBe(
        "https://example.test/v1/chat/completions?key=%3CREDACTED%3E",
      );
      expect(span?.events[0].attributes).toMatchObject({ ok: true, http_status: 200 });
    });
  });

  it("redacts nested sensitive attributes", () => {
    expect(
      sanitizeTraceAttributes({
        nested: { token: "xoxb-secret", ok: true },
        credential_env: "NVIDIA_API_KEY",
      }),
    ).toMatchObject({
      nested: '{"token":"<REDACTED>","ok":true}',
      credential_env: "NVIDIA_API_KEY",
    });
  });
});
