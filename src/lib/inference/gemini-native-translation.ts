// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: unknown;
};

/**
 * Schema keywords Gemini's function-declaration / structured-output schema object
 * recognizes (a subset of OpenAPI 3.0). Everything else (`$schema`, `additionalProperties`,
 * `oneOf`/`allOf`/`not`, `$defs`, vendor extras like `strict`) trips Gemini's validator, so
 * we filter to this allowlist — the same strategy LiteLLM (`filter_schema_fields`) and
 * Google ADK (`_sanitize_schema_formats_for_gemini`) use.
 */
const ALLOWED_SCHEMA_FIELDS = new Set<string>([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "pattern",
  "example",
  "default",
  "anyOf",
  "propertyOrdering",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveSchemaRef(
  ref: string,
  defs: Record<string, unknown>,
): Record<string, unknown> | null {
  const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
  if (!match) return null;
  const target = defs[match[1]];
  return isPlainObject(target) ? target : null;
}

/**
 * Recursively filter a JSON-Schema down to the keywords Gemini accepts: dereference `$ref`
 * against the root `$defs`/`definitions`, rewrite `oneOf`->`anyOf` and `const`->`enum`,
 * collapse nullable `anyOf` unions to `nullable`, then drop everything outside the allowlist.
 * Recurses through `properties`, `items`, and `anyOf`.
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  const defs: Record<string, unknown> = isPlainObject(schema)
    ? {
        ...(isPlainObject(schema.$defs) ? schema.$defs : {}),
        ...(isPlainObject(schema.definitions) ? schema.definitions : {}),
      }
    : {};
  return sanitizeSchemaNode(schema, defs);
}

function sanitizeSchemaNode(schema: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => sanitizeSchemaNode(entry, defs));
  if (!isPlainObject(schema)) return schema;

  let node: Record<string, unknown> = { ...schema };

  // Inline `$ref` (the node's own sibling keywords override the referenced definition).
  if (typeof node.$ref === "string") {
    const resolved = resolveSchemaRef(node.$ref, defs);
    const { $ref: _ref, ...rest } = node;
    node = resolved ? { ...resolved, ...rest } : rest;
  }

  // `oneOf` -> `anyOf`: Gemini supports `anyOf` but not `oneOf`/`allOf`/`not`.
  if (Array.isArray(node.oneOf) && node.anyOf === undefined) {
    node.anyOf = node.oneOf;
    delete node.oneOf;
  }
  // `const` -> single-value `enum`: Gemini has no `const`.
  if ("const" in node) {
    node.enum = [node.const];
    delete node.const;
  }
  // `anyOf` containing a `{type:"null"}` member -> `nullable: true` with the null member
  // dropped; if a single non-null member remains, collapse the union into it (the shape
  // most tool schemas actually want, e.g. an optional string).
  if (Array.isArray(node.anyOf)) {
    const members = node.anyOf as Array<Record<string, unknown>>;
    const hasNull = members.some((member) => isPlainObject(member) && member.type === "null");
    if (hasNull) {
      const nonNull = members.filter(
        (member) => !(isPlainObject(member) && member.type === "null"),
      );
      delete node.anyOf;
      if (nonNull.length === 1) {
        node = { ...nonNull[0], ...node };
      } else {
        node.anyOf = nonNull;
      }
      node.nullable = true;
    }
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_SCHEMA_FIELDS.has(key)) continue;
    if (key === "properties" && isPlainObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        properties[propertyName] = sanitizeSchemaNode(propertySchema, defs);
      }
      output[key] = properties;
    } else if (key === "items") {
      output[key] = sanitizeSchemaNode(value, defs);
    } else if (key === "anyOf" && Array.isArray(value)) {
      output[key] = value.map((entry) => sanitizeSchemaNode(entry, defs));
    } else {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Convert OpenAI-style tool definitions into Gemini `functionDeclarations`.
 *
 * Gemini's function-declaration translator is strict and rejects unknown fields on the
 * `function` object (`Unknown name ... at tools[N].function`), whereas OpenAI/DeepInfra
 * ignore them. Hermes emits extra fields (e.g. `strict`), so we extract only the
 * Gemini-recognized shape: `name`, `description`, `parameters`.
 */
export function toGeminiFunctionDeclarations(tools: unknown): GeminiFunctionDeclaration[] {
  if (!Array.isArray(tools)) return [];
  const declarations: GeminiFunctionDeclaration[] = [];
  for (const tool of tools) {
    const fn = (tool as { function?: Record<string, unknown> } | null)?.function;
    if (!fn || typeof fn !== "object") continue;
    const declaration: GeminiFunctionDeclaration = { name: String(fn.name) };
    if (fn.description !== undefined) declaration.description = String(fn.description);
    if (fn.parameters !== undefined) declaration.parameters = fn.parameters;
    declarations.push(declaration);
  }
  return declarations;
}

const THOUGHT_SIGNATURE_MARKER = "__gemsig__";

/**
 * Embed a Gemini-3 `thoughtSignature` into the OpenAI `tool_call.id`. Hermes echoes the id
 * back verbatim in conversation history, so encoding the signature here lets us recover and
 * replay it on the next turn (Gemini-3 *requires and validates* the signature on every
 * `functionCall` part) with no server-side state — restart-safe.
 */
export function encodeThoughtSignatureId(callId: string, signature: string | undefined): string {
  if (!signature) return callId;
  return `${callId}${THOUGHT_SIGNATURE_MARKER}${Buffer.from(signature, "utf8").toString("base64url")}`;
}

/** Inverse of {@link encodeThoughtSignatureId}: recover the original id + thoughtSignature. */
export function decodeThoughtSignatureId(id: string): { callId: string; signature?: string } {
  const markerIndex = id.indexOf(THOUGHT_SIGNATURE_MARKER);
  if (markerIndex < 0) return { callId: id };
  const callId = id.slice(0, markerIndex);
  const encoded = id.slice(markerIndex + THOUGHT_SIGNATURE_MARKER.length);
  try {
    return { callId, signature: Buffer.from(encoded, "base64url").toString("utf8") };
  } catch {
    return { callId: id };
  }
}

export type GeminiToolConfig = {
  functionCallingConfig: { mode: string; allowedFunctionNames?: string[] };
};

/**
 * Map an OpenAI `tool_choice` to Gemini's `toolConfig.functionCallingConfig`: `auto`->AUTO,
 * `required`/`any`->ANY, `none`->NONE, and a named function -> ANY restricted to that name via
 * `allowedFunctionNames` (which the OpenAI-compat shim has no equivalent for). Returns
 * undefined to let Gemini apply its default.
 */
export function toGeminiToolConfig(toolChoice: unknown): GeminiToolConfig | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === "string") {
    const mode =
      toolChoice === "auto"
        ? "AUTO"
        : toolChoice === "none"
          ? "NONE"
          : toolChoice === "required" || toolChoice === "any"
            ? "ANY"
            : undefined;
    return mode ? { functionCallingConfig: { mode } } : undefined;
  }
  if (isPlainObject(toolChoice)) {
    const fn = toolChoice.function;
    const name = isPlainObject(fn) ? fn.name : undefined;
    if (typeof name === "string") {
      return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
    }
  }
  return undefined;
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: unknown }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: unknown } };

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export type GeminiContents = {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
};

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isPlainObject(part) && part.type === "text" && typeof part.text === "string"
          ? part.text
          : "",
      )
      .join("");
  }
  return "";
}

function parseJsonOr(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Convert an OpenAI `messages` array into Gemini `contents` (+ `systemInstruction`):
 * - system/developer -> `systemInstruction` (lifted out of `contents`)
 * - user -> `{ role: "user", parts: [{ text }] }`
 * - assistant -> `{ role: "model", parts }` with text and/or `functionCall` parts; the
 *   `thoughtSignature` embedded in each `tool_call.id` is replayed onto the `functionCall`
 *   (Gemini-3 requires it)
 * - tool/function -> `{ role: "user", parts: [{ functionResponse }] }`
 */
export function buildGeminiContents(messages: unknown): GeminiContents {
  const list = Array.isArray(messages) ? messages : [];
  const contents: GeminiContent[] = [];
  const systemParts: Array<{ text: string }> = [];
  const toolNameById = new Map<string, string>();

  for (const raw of list) {
    if (!isPlainObject(raw)) continue;
    const role = String(raw.role || "").toLowerCase();

    if (role === "system" || role === "developer") {
      const text = textOfContent(raw.content);
      if (text) systemParts.push({ text });
    } else if (role === "user") {
      contents.push({ role: "user", parts: [{ text: textOfContent(raw.content) }] });
    } else if (role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = textOfContent(raw.content);
      if (text) parts.push({ text });
      const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const call of toolCalls) {
        if (!isPlainObject(call)) continue;
        const fn = isPlainObject(call.function) ? call.function : {};
        const name = String(fn.name || "");
        const { callId, signature } = decodeThoughtSignatureId(String(call.id || ""));
        toolNameById.set(callId, name);
        const part: { functionCall: { name: string; args: unknown }; thoughtSignature?: string } = {
          functionCall: { name, args: parseJsonOr(fn.arguments, {}) },
        };
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      contents.push({ role: "model", parts });
    } else if (role === "tool" || role === "function") {
      const { callId } = decodeThoughtSignatureId(String(raw.tool_call_id || ""));
      const name =
        typeof raw.name === "string" && raw.name ? raw.name : toolNameById.get(callId) || "";
      const parsed = parseJsonOr(raw.content, {});
      const response = isPlainObject(parsed) ? parsed : { result: parsed };
      contents.push({ role: "user", parts: [{ functionResponse: { name, response } }] });
    }
  }

  const result: GeminiContents = { contents };
  if (systemParts.length > 0) result.systemInstruction = { parts: systemParts };
  return result;
}

function mapGeminiFinishReason(reason: unknown): string {
  switch (String(reason || "").toUpperCase()) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      return "stop";
  }
}

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAiChatCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

/**
 * Convert a Gemini `generateContent` response into an OpenAI chat completion. `functionCall`
 * parts become `tool_calls` (each `thoughtSignature` is encoded into the `tool_call.id` so it
 * can be replayed next turn); `finish_reason` is `tool_calls` when any tool call is present,
 * otherwise the mapped Gemini `finishReason`.
 */
export function convertGeminiResponse(response: unknown, model: string): OpenAiChatCompletion {
  const resp = isPlainObject(response) ? response : {};
  const candidates = Array.isArray(resp.candidates) ? resp.candidates : [];
  const firstCandidate = isPlainObject(candidates[0]) ? candidates[0] : {};
  const content = isPlainObject(firstCandidate.content) ? firstCandidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];

  const textChunks: string[] = [];
  const toolCalls: OpenAiToolCall[] = [];
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    if (typeof part.text === "string") {
      textChunks.push(part.text);
    } else if (isPlainObject(part.functionCall)) {
      const functionCall = part.functionCall;
      const baseId = `gemini-call-${crypto.randomBytes(8).toString("hex")}`;
      const signature =
        typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
      toolCalls.push({
        id: encodeThoughtSignatureId(baseId, signature),
        type: "function",
        function: {
          name: String(functionCall.name || ""),
          arguments: JSON.stringify(functionCall.args ?? {}),
        },
      });
    }
  }

  const usage = isPlainObject(resp.usageMetadata) ? resp.usageMetadata : {};
  const message: OpenAiChatCompletion["choices"][number]["message"] = {
    role: "assistant",
    content: textChunks.length > 0 ? textChunks.join("") : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-gemini-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason:
          toolCalls.length > 0 ? "tool_calls" : mapGeminiFinishReason(firstCandidate.finishReason),
      },
    ],
    usage: {
      prompt_tokens: Number(usage.promptTokenCount || 0),
      completion_tokens: Number(usage.candidatesTokenCount || 0),
      total_tokens: Number(usage.totalTokenCount || 0),
    },
  };
}

export type GeminiGenerateContentRequest = {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  toolConfig?: GeminiToolConfig;
  generationConfig?: Record<string, unknown>;
};

/**
 * Assemble a Gemini `generateContent` request body from an OpenAI chat-completion request:
 * messages -> contents/systemInstruction, tools -> sanitized functionDeclarations, tool_choice
 * -> toolConfig, and sampling params -> generationConfig. The `model` rides in the URL path, so
 * it is not part of the returned body.
 */
export function buildGeminiRequest(request: unknown): GeminiGenerateContentRequest {
  const req = isPlainObject(request) ? request : {};
  const { contents, systemInstruction } = buildGeminiContents(req.messages);
  const result: GeminiGenerateContentRequest = { contents };
  if (systemInstruction) result.systemInstruction = systemInstruction;

  const declarations = toGeminiFunctionDeclarations(req.tools).map((declaration) =>
    declaration.parameters !== undefined
      ? { ...declaration, parameters: sanitizeGeminiSchema(declaration.parameters) }
      : declaration,
  );
  if (declarations.length > 0) {
    result.tools = [{ functionDeclarations: declarations }];
    const toolConfig = toGeminiToolConfig(req.tool_choice);
    if (toolConfig) result.toolConfig = toolConfig;
  }

  const generationConfig: Record<string, unknown> = {};
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens !== undefined && maxTokens !== null) {
    generationConfig.maxOutputTokens = Number(maxTokens);
  }
  if (req.temperature !== undefined && req.temperature !== null) {
    generationConfig.temperature = Number(req.temperature);
  }
  if (req.top_p !== undefined && req.top_p !== null) {
    generationConfig.topP = Number(req.top_p);
  }
  if (req.stop !== undefined && req.stop !== null) {
    generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;

  return result;
}

export type OpenAiStreamChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
};

/**
 * Stateful converter from a Gemini `streamGenerateContent` stream to OpenAI
 * `chat.completion.chunk` events. Maintains a stable id/created across the stream, assigns
 * monotonically increasing `tool_calls[].index` (the field Gemini's OpenAI-compat shim omits —
 * the original bug), encodes each `thoughtSignature` into the tool_call id, emits `role` on the
 * first delta, and reports `tool_calls` finish_reason when any tool call was streamed.
 */
export function createGeminiStreamConverter(model: string): {
  convertChunk(geminiChunk: unknown): OpenAiStreamChunk | null;
} {
  const id = `chatcmpl-gemini-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let toolIndex = 0;
  let emittedToolCall = false;
  let sentRole = false;

  return {
    convertChunk(geminiChunk: unknown): OpenAiStreamChunk | null {
      const chunk = isPlainObject(geminiChunk) ? geminiChunk : {};
      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
      const firstCandidate = isPlainObject(candidates[0]) ? candidates[0] : {};
      const content = isPlainObject(firstCandidate.content) ? firstCandidate.content : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];

      const delta: OpenAiStreamChunk["choices"][number]["delta"] = {};
      const textChunks: string[] = [];
      const toolCalls: NonNullable<OpenAiStreamChunk["choices"][number]["delta"]["tool_calls"]> =
        [];
      for (const part of parts) {
        if (!isPlainObject(part)) continue;
        if (typeof part.text === "string") {
          textChunks.push(part.text);
        } else if (isPlainObject(part.functionCall)) {
          const functionCall = part.functionCall;
          const baseId = `gemini-call-${crypto.randomBytes(8).toString("hex")}`;
          const signature =
            typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
          toolCalls.push({
            index: toolIndex++,
            id: encodeThoughtSignatureId(baseId, signature),
            type: "function",
            function: {
              name: String(functionCall.name || ""),
              arguments: JSON.stringify(functionCall.args ?? {}),
            },
          });
          emittedToolCall = true;
        }
      }
      if (textChunks.length > 0) delta.content = textChunks.join("");
      if (toolCalls.length > 0) delta.tool_calls = toolCalls;

      const hasFinish =
        firstCandidate.finishReason !== undefined && firstCandidate.finishReason !== null;
      const finishReason = hasFinish
        ? emittedToolCall
          ? "tool_calls"
          : mapGeminiFinishReason(firstCandidate.finishReason)
        : null;

      if (Object.keys(delta).length === 0 && finishReason === null) return null;

      if (!sentRole && Object.keys(delta).length > 0) {
        delta.role = "assistant";
        sentRole = true;
      }

      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
    },
  };
}
