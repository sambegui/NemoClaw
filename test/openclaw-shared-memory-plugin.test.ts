// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "openclaw-plugins",
  "shared-memory",
  "index.js",
);

const plugin = require(PLUGIN_PATH);

describe("nemoclaw OpenClaw shared-memory plugin", () => {
  it("is gated on sandbox memory endpoint and scope env", () => {
    expect(plugin.checkSharedMemoryRequirements({})).toBe(false);
    expect(
      plugin.checkSharedMemoryRequirements({
        OPENSHELL_MEMORY_URL: "http://memory.local/v1",
        OPENSHELL_MEMORY_SCOPE: "workspace:nemoclaw",
      }),
    ).toBe(true);
  });

  it("registers a shared_memory tool when the OpenClaw tool API is available", () => {
    const tools: any[] = [];

    plugin.register({
      registerTool(tool: any) {
        tools.push(tool);
      },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "shared_memory",
      name: "shared_memory",
    });
    expect(tools[0].parameters.properties.action.enum).toEqual([
      "publish",
      "query",
      "subscribe",
      "poll",
      "ack",
    ]);
  });

  it("builds OpenShell memory publish requests without exposing Redis settings", async () => {
    const captured: any[] = [];
    const handler = plugin.__testing.createSharedMemoryTool({
      env: {
        OPENSHELL_MEMORY_URL: "http://memory.local/v1/",
        OPENSHELL_MEMORY_SCOPE: "workspace:nemoclaw",
        OPENCLAW_AGENT_ID: "openclaw:planner",
        OPENSHELL_SANDBOX_ID: "openclaw-demo",
        OPENSHELL_MEMORY_REDIS_URL: "redis://:secret@redis.internal:6379/0",
      },
      requestJson(request: any) {
        captured.push(request);
        return Promise.resolve({ ok: true });
      },
    });

    const result = await handler({
      action: "publish",
      event_type: "project.convention.updated",
      subject: "testing",
      content: { summary: "Use Vitest for NemoClaw tests." },
    });

    expect(result).toEqual({ ok: true });
    expect(captured).toEqual([
      {
        method: "POST",
        url: "http://memory.local/v1/memory/events",
        body: {
          type: "project.convention.updated",
          scope: "workspace:nemoclaw",
          subject: "testing",
          content: { summary: "Use Vitest for NemoClaw tests." },
          provenance: {
            agent_id: "openclaw:planner",
            runtime: "openclaw",
            sandbox_id: "openclaw-demo",
            source: "agent_observation",
          },
          visibility: "shared",
          sensitivity: "normal",
          schema_version: 1,
        },
      },
    ]);
    expect(JSON.stringify(captured)).not.toContain("redis://");
  });

  it("queries through the configured scoped OpenShell endpoint", async () => {
    let request: any;
    const handler = plugin.__testing.createSharedMemoryTool({
      env: {
        OPENSHELL_MEMORY_URL: "http://memory.local/v1",
        OPENSHELL_MEMORY_SCOPE: "workspace:nemoclaw",
      },
      requestJson(value: any) {
        request = value;
        return Promise.resolve({ events: [] });
      },
    });

    const result = await handler({
      action: "query",
      event_type: "project.*",
      subject: "testing",
      limit: 5,
    });

    expect(result).toEqual({ events: [] });
    expect(request).toEqual({
      method: "GET",
      url: "http://memory.local/v1/memory/query?scope=workspace%3Anemoclaw&type=project.*&subject=testing&limit=5",
      body: undefined,
    });
  });

  it("validates ack inputs before calling the service", async () => {
    const handler = plugin.__testing.createSharedMemoryTool({
      env: {
        OPENSHELL_MEMORY_URL: "http://memory.local/v1",
        OPENSHELL_MEMORY_SCOPE: "workspace:nemoclaw",
      },
      requestJson() {
        throw new Error("request should not be sent");
      },
    });

    await expect(handler({ action: "ack", subscription_id: "sub" })).resolves.toMatchObject({
      error: "event_ids must be a non-empty list for ack.",
    });
  });
});
