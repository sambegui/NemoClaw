// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __test,
  AdapterHttpError,
  createGeminiNativeAdapterServer,
  type GeminiCaller,
} from "./gemini-native-adapter";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

function listen(server: http.Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as import("node:net").AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const TOKEN = "local-token";
const API_KEY = "test-gemini-key";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

describe("Gemini native OpenAI adapter", () => {
  it("converts a non-streaming functionCall response into OpenAI tool_calls", async () => {
    const generate = vi.fn(async ({ model, body }: { model: string; body: unknown }) => {
      expect(model).toBe("gemini-2.5-flash");
      // The translation layer should have produced Gemini-shaped contents.
      expect(body).toMatchObject({ contents: expect.any(Array) });
      return {
        status: 200,
        json: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { name: "get_weather", args: { city: "Seattle" } },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
        },
      };
    });
    const callGemini: GeminiCaller = {
      generate,
      stream: vi.fn(),
      listModels: vi.fn(),
    };

    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "weather in Seattle?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gemini-2.5-flash");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Seattle"}' },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not abort the upstream call when the request body is fully read (client still connected)", async () => {
    // Regression (2026-06-23): wiring the abort to the REQUEST stream's "close" event cancels every POST
    // the moment its body finishes being read — `req` "close" fires on normal completion, not only on a
    // client disconnect — so the upstream call runs on an already-aborted signal. A real upstream caller
    // (https.request/fetch) rejects synchronously when handed an already-aborted signal; this mock does
    // the same, so the test is RED against `req.on("close")` and GREEN against the `res`-keyed fix.
    const generate = vi.fn(
      async ({ signal }: { model: string; body: unknown; signal?: AbortSignal }) => {
        // A real upstream caller (https.request/fetch) throws synchronously when handed an
        // already-aborted signal. `throwIfAborted()` does exactly that with no branch: under the
        // buggy `req.on("close")` wiring the signal is already aborted here → throws → 502 (RED);
        // under the `res.on("close")` fix it is not aborted → resolves 200 (GREEN).
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("upstream aborted mid-call"));
          });
        });
        return {
          status: 200,
          json: {
            candidates: [
              { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
            ],
          },
        };
      },
    );
    const callGemini: GeminiCaller = { generate, stream: vi.fn(), listModels: vi.fn() };

    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight upstream call when the client disconnects mid-request", async () => {
    // Proves the fix's actual benefit (and guards against silently dropping cancellation): a genuine
    // client disconnect — the response stream closes before we finish writing — cancels the upstream
    // Gemini call. Fails when no abort is wired at all.
    let upstreamSignal: AbortSignal | undefined;
    const generate = vi.fn(({ signal }: { model: string; body: unknown; signal?: AbortSignal }) => {
      upstreamSignal = signal;
      // Settles only when the request is aborted (the disconnect path).
      return new Promise<{ status: number; json: unknown }>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("upstream aborted")));
      });
    });
    const callGemini: GeminiCaller = { generate, stream: vi.fn(), listModels: vi.fn() };

    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const clientAbort = new AbortController();
    const pending = fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
      signal: clientAbort.signal,
    }).catch(() => undefined);

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    clientAbort.abort();

    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    await pending;
  });

  it("streams Gemini chunks as OpenAI chat.completion.chunk events ending with [DONE]", async () => {
    async function* geminiStream() {
      yield {
        candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }],
      };
      yield {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "get_weather", args: { city: "Seattle" } } }],
            },
            finishReason: "STOP",
          },
        ],
      };
    }
    const stream = vi.fn(async ({ model }: { model: string }) => {
      expect(model).toBe("gemini-2.5-flash");
      return geminiStream();
    });
    const callGemini: GeminiCaller = {
      generate: vi.fn(),
      stream,
      listModels: vi.fn(),
    };

    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "weather in Seattle?" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));

    expect(dataLines.at(-1)).toBe("[DONE]");

    const events = dataLines
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as any);

    expect(events.every((event) => event.object === "chat.completion.chunk")).toBe(true);
    // First text delta carries the assistant role and the text.
    expect(events[0].choices[0].delta.role).toBe("assistant");
    expect(events[0].choices[0].delta.content).toBe("Hello");
    // Tool call delta carries an indexed tool_call.
    const toolEvent = events.find((event) => event.choices[0].delta.tool_calls);
    expect(toolEvent.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Seattle"}' },
    });
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("rejects requests without a valid bearer token and never calls upstream", async () => {
    const generate = vi.fn();
    const stream = vi.fn();
    const listModels = vi.fn();
    const callGemini: GeminiCaller = { generate, stream, listModels };

    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const missing = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-2.5-flash", messages: [] }),
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-2.5-flash", messages: [] }),
    });
    expect(wrong.status).toBe(401);

    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
  });

  it("returns an OpenAI-shaped model list from /v1/models", async () => {
    const listModels = vi.fn(async () => ({
      status: 200,
      json: {
        models: [
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
          { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
        ],
      },
    }));
    const callGemini: GeminiCaller = {
      generate: vi.fn(),
      stream: vi.fn(),
      listModels,
    };

    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      { id: "gemini-2.5-flash", object: "model", owned_by: "google" },
      { id: "gemini-2.5-pro", object: "model", owned_by: "google" },
    ]);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("relays an upstream error status from generateContent", async () => {
    const generate = vi.fn(async () => ({
      status: 400,
      json: {
        error: {
          code: 400,
          message: "Invalid argument: tools[0].function.parameters",
          status: "INVALID_ARGUMENT",
        },
      },
    }));
    const callGemini: GeminiCaller = {
      generate,
      stream: vi.fn(),
      listModels: vi.fn(),
    };

    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("Invalid argument");
  });

  it("returns 400 for malformed JSON request bodies", async () => {
    const callGemini: GeminiCaller = {
      generate: vi.fn(),
      stream: vi.fn(),
      listModels: vi.fn(),
    };
    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: "{ not json",
    });
    expect(response.status).toBe(400);
    expect(callGemini.generate as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("returns a real error status (not 200 + SSE) when a streaming upstream fails before any bytes", async () => {
    const stream = vi.fn(async () => {
      throw new AdapterHttpError(429, "Resource exhausted", "rate_limited");
    });
    const callGemini: GeminiCaller = { generate: vi.fn(), stream, listModels: vi.fn() };
    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as any;
    expect(body.error).toBeDefined();
  });

  it("returns 404 for unknown routes", async () => {
    const callGemini: GeminiCaller = {
      generate: vi.fn(),
      stream: vi.fn(),
      listModels: vi.fn(),
    };
    const server = createGeminiNativeAdapterServer({ apiKey: API_KEY, token: TOKEN, callGemini });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/nonsense`, { headers: authHeaders() });
    expect(response.status).toBe(404);
  });
});

// A stalled upstream connection (e.g. a stale keep-alive socket to Google) must never hang the
// adapter. The default caller wraps each idempotent attempt in a single retry on transient
// stalls/resets so one bad socket is recovered on a fresh one instead of freezing the request.
describe("withUpstreamRetry", () => {
  it("returns the result without retrying when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await __test.withUpstreamRetry(
      async () => {
        calls++;
        return "ok";
      },
      { isRetryable: () => true },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries once on a retryable error then succeeds", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(
        new AdapterHttpError(504, "Gemini upstream timed out", "upstream_timeout"),
      )
      .mockResolvedValueOnce("ok");
    const result = await __test.withUpstreamRetry(attempt, {
      isRetryable: __test.isRetryableUpstreamError,
    });
    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and throws the last error", async () => {
    let calls = 0;
    await expect(
      __test.withUpstreamRetry(
        async () => {
          calls++;
          throw new AdapterHttpError(504, "Gemini upstream timed out", "upstream_timeout");
        },
        { isRetryable: () => true },
      ),
    ).rejects.toBeInstanceOf(AdapterHttpError);
    expect(calls).toBe(2);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    await expect(
      __test.withUpstreamRetry(
        async () => {
          calls++;
          throw new AdapterHttpError(400, "Invalid argument", "gemini_error");
        },
        { isRetryable: __test.isRetryableUpstreamError },
      ),
    ).rejects.toBeInstanceOf(AdapterHttpError);
    expect(calls).toBe(1);
  });
});

describe("isRetryableUpstreamError", () => {
  it("treats a 504 upstream timeout as retryable", () => {
    expect(
      __test.isRetryableUpstreamError(new AdapterHttpError(504, "timed out", "upstream_timeout")),
    ).toBe(true);
  });

  it("treats a 4xx upstream error as non-retryable", () => {
    expect(
      __test.isRetryableUpstreamError(new AdapterHttpError(400, "bad request", "gemini_error")),
    ).toBe(false);
  });

  it("treats socket reset/timeout codes as retryable", () => {
    expect(__test.isRetryableUpstreamError({ code: "ECONNRESET" })).toBe(true);
    expect(__test.isRetryableUpstreamError({ code: "ETIMEDOUT" })).toBe(true);
    expect(__test.isRetryableUpstreamError({ code: "EPIPE" })).toBe(true);
  });

  it("treats an unknown error as non-retryable", () => {
    expect(__test.isRetryableUpstreamError(new Error("boom"))).toBe(false);
  });
});
