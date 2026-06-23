// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildGeminiContents,
  buildGeminiRequest,
  convertGeminiResponse,
  createGeminiStreamConverter,
  decodeThoughtSignatureId,
  encodeThoughtSignatureId,
  sanitizeGeminiSchema,
  toGeminiFunctionDeclarations,
  toGeminiToolConfig,
} from "./gemini-native-translation";

describe("toGeminiFunctionDeclarations", () => {
  it("extracts only name/description/parameters, dropping extra function-object fields that Gemini rejects", () => {
    // Hermes emits OpenAI tool defs whose `function` object carries extra fields
    // (e.g. `strict`). Gemini's functionDeclarations translator is strict and 400s on
    // unknown fields ("Unknown name ... at tools[N].function"), unlike OpenAI/DeepInfra.
    const openAiTools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a location",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
          strict: true,
        },
      },
    ];

    const declarations = toGeminiFunctionDeclarations(openAiTools);

    expect(declarations).toEqual([
      {
        name: "get_weather",
        description: "Get the weather for a location",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    ]);
  });
});

describe("sanitizeGeminiSchema", () => {
  it("recursively drops JSON-Schema keywords Gemini's schema object rejects, keeping allowlisted fields", () => {
    // Gemini's parameters schema accepts only a subset of OpenAPI 3.0. Keywords like
    // `$schema`, `additionalProperties`, `oneOf`, and vendor extras (`strict`) trip its
    // validator; mature adapters (LiteLLM/ADK) filter to an allowlist, recursively.
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      strict: true,
      properties: {
        q: { type: "string", description: "query" },
        nested: {
          type: "object",
          additionalProperties: true,
          properties: { a: { type: "number", minimum: 0 } },
        },
      },
      required: ["q"],
    };

    expect(sanitizeGeminiSchema(schema)).toEqual({
      type: "object",
      properties: {
        q: { type: "string", description: "query" },
        nested: {
          type: "object",
          properties: { a: { type: "number", minimum: 0 } },
        },
      },
      required: ["q"],
    });
  });

  it("rewrites oneOf to anyOf (Gemini supports anyOf, not oneOf)", () => {
    expect(sanitizeGeminiSchema({ oneOf: [{ type: "string" }, { type: "integer" }] })).toEqual({
      anyOf: [{ type: "string" }, { type: "integer" }],
    });
  });

  it("converts const to a single-value enum (Gemini has no const)", () => {
    expect(sanitizeGeminiSchema({ type: "string", const: "fixed" })).toEqual({
      type: "string",
      enum: ["fixed"],
    });
  });

  it("collapses a nullable anyOf union to nullable + the single non-null member", () => {
    expect(sanitizeGeminiSchema({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({
      type: "string",
      nullable: true,
    });
  });
});

describe("createGeminiStreamConverter", () => {
  it("converts a text stream chunk to an OpenAI delta chunk (role on the first chunk)", () => {
    const converter = createGeminiStreamConverter("gemini-2.5-flash");
    const chunk = converter.convertChunk({
      candidates: [{ content: { parts: [{ text: "Hel" }] } }],
    });
    expect(chunk?.object).toBe("chat.completion.chunk");
    expect(chunk?.choices[0].delta).toEqual({ role: "assistant", content: "Hel" });
    expect(chunk?.choices[0].finish_reason).toBeNull();
  });

  it("emits tool_call deltas with incrementing index + encoded signature, then tool_calls finish_reason", () => {
    const converter = createGeminiStreamConverter("gemini-3-flash-preview");
    const first = converter.convertChunk({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "get_weather", args: { location: "Paris" } },
                thoughtSignature: "SIG",
              },
            ],
          },
        },
      ],
    });
    const toolCall = first?.choices[0].delta.tool_calls?.[0];
    expect(toolCall?.index).toBe(0);
    expect(toolCall?.function).toEqual({ name: "get_weather", arguments: '{"location":"Paris"}' });
    expect(decodeThoughtSignatureId(toolCall?.id ?? "").signature).toBe("SIG");

    const final = converter.convertChunk({ candidates: [{ finishReason: "STOP" }] });
    expect(final?.choices[0].finish_reason).toBe("tool_calls");
  });

  it("returns null for an empty chunk (no delta, no finish_reason)", () => {
    const converter = createGeminiStreamConverter("gemini-2.5-flash");
    expect(converter.convertChunk({ candidates: [{}] })).toBeNull();
  });
});

describe("buildGeminiRequest", () => {
  it("assembles contents, systemInstruction, sanitized functionDeclarations, toolConfig, and generationConfig", () => {
    const req = buildGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: "You are Atlas." },
        { role: "user", content: "weather?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "w",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { location: { type: "string" } },
              required: ["location"],
            },
            strict: true,
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 256,
      temperature: 0.5,
    });
    expect(req.systemInstruction).toEqual({ parts: [{ text: "You are Atlas." }] });
    expect(req.contents).toEqual([{ role: "user", parts: [{ text: "weather?" }] }]);
    expect(req.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "w",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
            },
          },
        ],
      },
    ]);
    expect(req.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(req.generationConfig).toEqual({ maxOutputTokens: 256, temperature: 0.5 });
  });

  it("omits tools, toolConfig, and generationConfig when absent", () => {
    const req = buildGeminiRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(req.tools).toBeUndefined();
    expect(req.toolConfig).toBeUndefined();
    expect(req.generationConfig).toBeUndefined();
  });
});

describe("convertGeminiResponse", () => {
  it("converts a Gemini text response to an OpenAI assistant message", () => {
    const out = convertGeminiResponse(
      {
        candidates: [
          { content: { role: "model", parts: [{ text: "Hello!" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      },
      "gemini-2.5-flash",
    );
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("gemini-2.5-flash");
    expect(out.choices[0].message.content).toBe("Hello!");
    expect(out.choices[0].message.tool_calls).toBeUndefined();
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it("converts a functionCall response to a tool_call (encoding thoughtSignature into the id, finish_reason=tool_calls)", () => {
    const out = convertGeminiResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: { name: "get_weather", args: { location: "Paris" } },
                  thoughtSignature: "SIG123",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
      "gemini-3-flash-preview",
    );
    expect(out.choices[0].message.content).toBeNull();
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    const call = out.choices[0].message.tool_calls?.[0];
    expect(call?.type).toBe("function");
    expect(call?.function).toEqual({ name: "get_weather", arguments: '{"location":"Paris"}' });
    expect(decodeThoughtSignatureId(call?.id ?? "").signature).toBe("SIG123");
  });
});

describe("buildGeminiContents", () => {
  it("maps user and assistant text messages to user/model role contents", () => {
    const { contents, systemInstruction } = buildGeminiContents([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ]);
    expect(systemInstruction).toBeUndefined();
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello there" }] },
    ]);
  });

  it("lifts system/developer messages into systemInstruction (not contents)", () => {
    const { contents, systemInstruction } = buildGeminiContents([
      { role: "system", content: "You are Atlas." },
      { role: "user", content: "hi" },
    ]);
    expect(systemInstruction).toEqual({ parts: [{ text: "You are Atlas." }] });
    expect(contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("maps tool_calls to model functionCall parts (replaying thoughtSignature) and tool results to user functionResponse parts", () => {
    const toolId = encodeThoughtSignatureId("call_1", "SIG123");
    const { contents } = buildGeminiContents([
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolId,
            type: "function",
            function: { name: "get_weather", arguments: '{"location":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: toolId, name: "get_weather", content: '{"temp":"15C"}' },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "weather in Paris?" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "get_weather", args: { location: "Paris" } },
            thoughtSignature: "SIG123",
          },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", response: { temp: "15C" } } }],
      },
    ]);
  });
});

describe("toGeminiToolConfig", () => {
  it("maps the string tool_choice values to functionCallingConfig modes", () => {
    expect(toGeminiToolConfig("auto")).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(toGeminiToolConfig("required")).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(toGeminiToolConfig("none")).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(toGeminiToolConfig(undefined)).toBeUndefined();
  });

  it("restricts to a named function via ANY + allowedFunctionNames", () => {
    expect(toGeminiToolConfig({ type: "function", function: { name: "get_weather" } })).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
    });
  });
});

describe("thoughtSignature round-trip via tool_call id", () => {
  it("embeds a thoughtSignature in the id and decodes it back (Gemini-3 requires replay)", () => {
    const encoded = encodeThoughtSignatureId("call_1", "Cg0KAxc=SIG+/value==");
    expect(encoded).not.toBe("call_1");
    expect(decodeThoughtSignatureId(encoded)).toEqual({
      callId: "call_1",
      signature: "Cg0KAxc=SIG+/value==",
    });
  });

  it("passes an id through unchanged when there is no signature", () => {
    expect(encodeThoughtSignatureId("call_1", undefined)).toBe("call_1");
    expect(decodeThoughtSignatureId("call_1")).toEqual({ callId: "call_1" });
  });
});

describe("sanitizeGeminiSchema $ref", () => {
  it("dereferences $ref against root $defs and inlines the definition (dropping $defs)", () => {
    const schema = {
      $defs: { Loc: { type: "string", description: "a location" } },
      type: "object",
      properties: {
        from: { $ref: "#/$defs/Loc" },
        to: { $ref: "#/$defs/Loc" },
      },
      required: ["from"],
    };
    expect(sanitizeGeminiSchema(schema)).toEqual({
      type: "object",
      properties: {
        from: { type: "string", description: "a location" },
        to: { type: "string", description: "a location" },
      },
      required: ["from"],
    });
  });
});
