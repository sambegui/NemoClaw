// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { compactText } from "../core/url-utils";
import {
  buildGeminiRequest,
  convertGeminiResponse,
  createGeminiStreamConverter,
  type GeminiGenerateContentRequest,
} from "./gemini-native-translation";
import {
  appendLocalAdapterJsonLine,
  DEFAULT_LOCAL_ADAPTER_STATE_DIR,
  type JsonObject,
  localAdapterTokenHash,
} from "./local-adapter-lifecycle";

export {
  buildGeminiRequest,
  convertGeminiResponse,
  createGeminiStreamConverter,
} from "./gemini-native-translation";

/**
 * Lightweight, transport-agnostic HTTP error carrying the status/code an HTTP handler should
 * surface. Mirrors the Bedrock adapter's `AdapterHttpError` so error handling reads the same
 * across native adapters.
 */
export class AdapterHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "bad_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Result of a unary upstream call: the HTTP status Google returned plus the parsed JSON body. */
export type GeminiCallResult = { status: number; json: unknown };

/** Parameters for a single Gemini upstream invocation (the model rides in the URL path). */
export type GeminiCallParams = {
  model: string;
  body: GeminiGenerateContentRequest;
  signal?: AbortSignal;
};

/**
 * Injectable upstream so tests can fake Google. The default implementation
 * ({@link createDefaultGeminiCaller}) makes real HTTPS calls and holds the `GEMINI_API_KEY`.
 */
export type GeminiCaller = {
  /** Unary `:generateContent`. */
  generate(params: GeminiCallParams): Promise<GeminiCallResult>;
  /** Streaming `:streamGenerateContent?alt=sse`, yielding PARSED Gemini chunk objects. */
  stream(params: GeminiCallParams): Promise<AsyncIterable<unknown>>;
  /** `GET /models` for the model-list route. */
  listModels(options?: { signal?: AbortSignal }): Promise<GeminiCallResult>;
};

type AdapterLogFields = Record<string, string | number | boolean | null | undefined>;
type AdapterLogger = (event: string, fields?: AdapterLogFields) => void;

export type GeminiNativeAdapterOptions = {
  /** GEMINI_API_KEY — held here and injected to Google as `x-goog-api-key`. Never logged. */
  apiKey: string;
  /** Local Bearer token the boundary must present on every route. */
  token: string;
  /** Injectable upstream; defaults to real HTTPS calls to Google. */
  callGemini?: GeminiCaller;
  /** Override Google's base URL (default {@link DEFAULT_GEMINI_BASE_URL}). */
  baseUrl?: string;
  logger?: AdapterLogger;
};

export const LOG_PATH = path.join(DEFAULT_LOCAL_ADAPTER_STATE_DIR, "gemini-native-adapter.log");

function normalizeLogField(
  value: string | number | boolean | null | undefined,
): string | number | boolean | null {
  if (value === undefined) return null;
  if (typeof value === "string") return compactText(value).slice(0, 180);
  return value;
}

function defaultAdapterLogger(event: string, fields: AdapterLogFields = {}): void {
  try {
    const payload: Record<string, string | number | boolean | null> = {
      ts: new Date().toISOString(),
      event: normalizeLogField(event) as string,
    };
    for (const [key, value] of Object.entries(fields)) {
      payload[key] = normalizeLogField(value);
    }
    appendLocalAdapterJsonLine(LOG_PATH, payload);
  } catch {
    /* best-effort diagnostics only */
  }
}

function logAdapterEvent(
  logger: AdapterLogger,
  event: string,
  fields: AdapterLogFields = {},
): void {
  try {
    logger(event, fields);
  } catch {
    /* best-effort diagnostics only */
  }
}

function authMatches(actual: string | string[] | undefined, token: string): boolean {
  const header = Array.isArray(actual) ? actual[0] : actual;
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function adapterTokenHash(token: string): string {
  return localAdapterTokenHash(token);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendUnauthorized(res: http.ServerResponse): void {
  sendJson(res, 401, {
    error: { message: "Unauthorized", type: "unauthorized", code: "unauthorized" },
  });
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof AdapterHttpError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Gemini request failed.";
}

function sendError(res: http.ServerResponse, err: unknown): void {
  const status = err instanceof AdapterHttpError ? err.status : 502;
  const code = err instanceof AdapterHttpError ? err.code : "gemini_error";
  sendJson(res, status, {
    error: {
      message: compactText(safeErrorMessage(err)),
      type: code,
      code,
    },
  });
}

function parseJsonObject(raw: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AdapterHttpError(400, `Invalid JSON in ${label}.`, "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdapterHttpError(400, `Expected a JSON object for ${label}.`, "invalid_request");
  }
  return parsed as JsonObject;
}

function readRequestJson(req: http.IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AdapterHttpError(413, "Request body is too large.", "request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(parseJsonObject(Buffer.concat(chunks).toString("utf8"), "request body"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function resolveModel(body: JsonObject): string {
  return typeof body.model === "string" && body.model.trim() ? body.model.trim() : "unknown";
}

/**
 * Map a Gemini `GET /models` response to the OpenAI `GET /v1/models` shape. Gemini reports model
 * names as `models/<id>` (e.g. `models/gemini-2.5-flash`); we strip the `models/` prefix so the
 * sandbox sees plain OpenAI model ids.
 */
function toOpenAiModelList(json: unknown): {
  object: "list";
  data: Array<{ id: string; object: "model"; owned_by: "google" }>;
} {
  const models =
    json && typeof json === "object" && Array.isArray((json as JsonObject).models)
      ? ((json as JsonObject).models as unknown[])
      : [];
  const data: Array<{ id: string; object: "model"; owned_by: "google" }> = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as JsonObject).name;
    if (typeof name !== "string" || !name) continue;
    const id = name.startsWith("models/") ? name.slice("models/".length) : name;
    data.push({ id, object: "model", owned_by: "google" });
  }
  return { object: "list", data };
}

export function createGeminiNativeAdapterServer(options: GeminiNativeAdapterOptions): http.Server {
  const logger = options.logger || defaultAdapterLogger;
  const baseUrl = options.baseUrl || DEFAULT_GEMINI_BASE_URL;
  const callGemini =
    options.callGemini || createDefaultGeminiCaller({ apiKey: options.apiKey, baseUrl });

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const abortController = new AbortController();
    // Cancel the in-flight upstream call only on a genuine client disconnect — i.e. the response
    // stream closed before we finished writing it. Keying off the *request* stream's "close" is
    // wrong: it fires when the request body finishes being read (normal completion), which would
    // abort every POST before its upstream call runs.
    res.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });
    let model = "unknown";
    let operation = "unknown";
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          baseUrl,
          tokenHash: adapterTokenHash(options.token),
        });
        return;
      }

      if (!authMatches(req.headers.authorization, options.token)) {
        sendUnauthorized(res);
        logAdapterEvent(logger, "request_rejected", {
          method: req.method || "unknown",
          path: url.pathname,
          status: 401,
          reason: "unauthorized",
          durationMs: Date.now() - started,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        operation = "list_models";
        const result = await callGemini.listModels({ signal: abortController.signal });
        if (result.status >= 400) {
          relayUpstreamError(res, result);
          logAdapterEvent(logger, "request_failed", {
            operation,
            status: result.status,
            durationMs: Date.now() - started,
          });
          return;
        }
        sendJson(res, 200, toOpenAiModelList(result.json));
        logAdapterEvent(logger, "request_completed", {
          operation,
          status: 200,
          durationMs: Date.now() - started,
        });
        return;
      }

      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        sendJson(res, 404, {
          error: { message: "Not found", type: "not_found", code: "not_found" },
        });
        logAdapterEvent(logger, "request_rejected", {
          method: req.method || "unknown",
          path: url.pathname,
          status: 404,
          reason: "not_found",
          durationMs: Date.now() - started,
        });
        return;
      }

      const body = await readRequestJson(req);
      model = resolveModel(body);
      const geminiBody = buildGeminiRequest(body);

      if (body.stream === true) {
        operation = "stream_generate_content";
        // Establish the upstream stream BEFORE committing response headers: an upstream error
        // before any bytes (e.g. a 4xx) then surfaces as a proper error status via the catch
        // below, rather than a 200 with an SSE error event the client can't act on.
        const chunks = await callGemini.stream({
          model,
          body: geminiBody,
          signal: abortController.signal,
        });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const converter = createGeminiStreamConverter(model);
        for await (const chunk of chunks) {
          const openAiChunk = converter.convertChunk(chunk);
          if (openAiChunk) {
            res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`);
          }
        }
        res.write("data: [DONE]\n\n");
        res.end();
        logAdapterEvent(logger, "request_completed", {
          operation,
          model,
          status: 200,
          stream: true,
          durationMs: Date.now() - started,
        });
        return;
      }

      operation = "generate_content";
      const result = await callGemini.generate({
        model,
        body: geminiBody,
        signal: abortController.signal,
      });
      if (result.status >= 400) {
        relayUpstreamError(res, result);
        logAdapterEvent(logger, "request_failed", {
          operation,
          model,
          status: result.status,
          durationMs: Date.now() - started,
        });
        return;
      }
      sendJson(res, 200, convertGeminiResponse(result.json, model));
      logAdapterEvent(logger, "request_completed", {
        operation,
        model,
        status: 200,
        stream: false,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const status = err instanceof AdapterHttpError ? err.status : 502;
      const code = err instanceof AdapterHttpError ? err.code : "gemini_error";
      logAdapterEvent(logger, "request_failed", {
        operation,
        model,
        status,
        code,
        durationMs: Date.now() - started,
      });
      if (!res.headersSent) {
        sendError(res, err);
      } else {
        res.write(
          `data: ${JSON.stringify({ error: { message: compactText(safeErrorMessage(err)) } })}\n\n`,
        );
        res.end();
      }
    }
  });
}

/**
 * Relay an upstream Gemini error to the caller with the same status. Gemini errors are shaped
 * `{ error: { code, message, status } }`; we surface an OpenAI-shaped `{ error: { message, type,
 * code } }` so the sandbox's OpenAI client can parse it, preserving Google's message.
 */
function relayUpstreamError(res: http.ServerResponse, result: GeminiCallResult): void {
  const upstream =
    result.json && typeof result.json === "object" ? (result.json as JsonObject) : {};
  const upstreamError =
    upstream.error && typeof upstream.error === "object"
      ? (upstream.error as JsonObject)
      : undefined;
  const message =
    upstreamError && typeof upstreamError.message === "string"
      ? upstreamError.message
      : `Gemini request failed with status ${result.status}.`;
  const status =
    upstreamError && typeof upstreamError.status === "string" ? upstreamError.status : undefined;
  sendJson(res, result.status, {
    error: {
      message: compactText(message),
      type: status || "gemini_error",
      code: status || "gemini_error",
    },
  });
}

type ParsedHttpsResponse = { status: number; text: string };

/** POST JSON to Google over HTTPS, buffering the whole response (for the unary routes). */
function httpsJson(
  urlString: string,
  options: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<ParsedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request(
      {
        method: options.method,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: options.headers,
        signal: options.signal,
        agent: upstreamAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({ status: res.statusCode || 502, text: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    attachIdleTimeout(req, options.timeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS);
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function parseMaybeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: compactText(text) || "Non-JSON upstream response." } };
  }
}

/**
 * Stream Gemini SSE (`?alt=sse`) over HTTPS, parsing `data: {...}` lines into objects and yielding
 * them. Gemini's SSE frames are line-delimited `data:` events separated by blank lines; we split
 * on newlines, parse each `data:` payload, and skip anything that is not valid JSON (keep-alives,
 * partial frames stitched across chunk boundaries via the line buffer).
 */
async function* parseGeminiSse(res: http.IncomingMessage): AsyncGenerator<unknown> {
  let buffer = "";
  for await (const chunk of res) {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      const parsed = parseSseDataLine(line);
      if (parsed !== undefined) yield parsed;
      newlineIndex = buffer.indexOf("\n");
    }
  }
  const tail = parseSseDataLine(buffer.replace(/\r$/, ""));
  if (tail !== undefined) yield tail;
}

function parseSseDataLine(line: string): unknown {
  if (!line.startsWith("data:")) return undefined;
  const payload = line.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/**
 * Idle (no-data) timeout for an upstream Gemini connection. Generous enough to never trip on a
 * legitimately slow first byte from a thinking model, but bounded so a dead/stalled socket can
 * never hang the request indefinitely. Tripping it surfaces a retryable 504.
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * Pooled keep-alive agent for upstream calls. Reusing an established TLS connection both lowers
 * latency and avoids the per-call handshake that, on a flaky egress path, is itself an occasional
 * source of connection-setup stalls. `timeout` prunes sockets that sit idle long enough to have
 * gone stale, so a reused socket is rarely half-closed; the per-request idle timeout + retry are
 * the backstop for the residual case.
 */
const upstreamAgent = new https.Agent({ keepAlive: true, timeout: 30_000, maxSockets: 64 });

/** Arm a socket-inactivity timeout that destroys the request with a retryable 504 if it stalls. */
function attachIdleTimeout(req: http.ClientRequest, timeoutMs: number): void {
  req.setTimeout(timeoutMs, () => {
    req.destroy(new AdapterHttpError(504, "Gemini upstream timed out.", "upstream_timeout"));
  });
}

/** Whether an upstream failure is a transient stall/reset worth a single fresh-socket retry. */
function isRetryableUpstreamError(err: unknown): boolean {
  if (err instanceof AdapterHttpError) return err.status === 504;
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EPIPE"
  );
}

/**
 * Run an idempotent upstream attempt with a bounded retry budget. Gemini reads are side-effect
 * free, so a transient stall (e.g. a stale keep-alive socket) is recovered on a fresh connection
 * rather than failing the caller. Non-retryable errors (4xx, unknown) propagate immediately.
 */
async function withUpstreamRetry<T>(
  attempt: () => Promise<T>,
  opts: { retries?: number; isRetryable: (err: unknown) => boolean },
): Promise<T> {
  const total = (opts.retries ?? 1) + 1;
  let lastError: unknown;
  for (let i = 0; i < total; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (i === total - 1 || !opts.isRetryable(err)) throw err;
    }
  }
  throw lastError;
}

/**
 * Default upstream that holds the real `GEMINI_API_KEY` and makes HTTPS calls to Google's native
 * `generateContent`/`streamGenerateContent`/`models` endpoints. The key is injected only as the
 * `x-goog-api-key` header and is never logged.
 */
export function createDefaultGeminiCaller(config: {
  apiKey: string;
  baseUrl?: string;
}): GeminiCaller {
  const baseUrl = (config.baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, "");
  const jsonHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-goog-api-key": config.apiKey,
  });

  return {
    async generate({ model, body, signal }) {
      const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
      return withUpstreamRetry(
        async () => {
          const res = await httpsJson(url, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify(body),
            signal,
          });
          return { status: res.status, json: parseMaybeJson(res.text) };
        },
        { isRetryable: isRetryableUpstreamError },
      );
    },

    async stream({ model, body, signal }) {
      const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const parsed = new URL(url);
      const openStream = () =>
        new Promise<AsyncIterable<unknown>>((resolve, reject) => {
          const req = https.request(
            {
              method: "POST",
              hostname: parsed.hostname,
              port: parsed.port || 443,
              path: `${parsed.pathname}${parsed.search}`,
              headers: { ...jsonHeaders(), accept: "text/event-stream" },
              signal,
              agent: upstreamAgent,
            },
            (res) => {
              if ((res.statusCode || 502) >= 400) {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                res.on("end", () => {
                  const text = Buffer.concat(chunks).toString("utf8");
                  const json = parseMaybeJson(text) as JsonObject;
                  const message =
                    json.error && typeof json.error === "object"
                      ? compactText(String((json.error as JsonObject).message || ""))
                      : `Gemini stream failed with status ${res.statusCode}.`;
                  reject(new AdapterHttpError(res.statusCode || 502, message, "gemini_error"));
                });
                return;
              }
              resolve(parseGeminiSse(res));
            },
          );
          attachIdleTimeout(req, UPSTREAM_IDLE_TIMEOUT_MS);
          req.on("error", reject);
          req.write(JSON.stringify(body));
          req.end();
        });
      return withUpstreamRetry(openStream, { isRetryable: isRetryableUpstreamError });
    },

    async listModels({ signal } = {}) {
      return withUpstreamRetry(
        async () => {
          const res = await httpsJson(`${baseUrl}/models`, {
            method: "GET",
            headers: jsonHeaders(),
            signal,
          });
          return { status: res.status, json: parseMaybeJson(res.text) };
        },
        { isRetryable: isRetryableUpstreamError },
      );
    },
  };
}

export const __test = {
  toOpenAiModelList,
  relayUpstreamError,
  parseSseDataLine,
  withUpstreamRetry,
  isRetryableUpstreamError,
};
