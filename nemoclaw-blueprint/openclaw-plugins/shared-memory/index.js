// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const { URL, URLSearchParams } = require("node:url");

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

const SHARED_MEMORY_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["publish", "query", "subscribe", "poll", "ack"],
      description: "Operation to perform.",
    },
    event_type: {
      type: "string",
      description: "Dot-delimited event type, such as project.convention.updated.",
    },
    subject: {
      type: "string",
      description: "Stable topic/entity inside the configured memory scope.",
    },
    content: {
      type: "object",
      description: "Structured event content for publish.",
    },
    subscription_id: {
      type: "string",
      description: "Subscription identifier for subscribe, poll, and ack.",
    },
    filters: {
      type: "object",
      description: "Subscription filters, such as { types: ['project.*'] }.",
    },
    event_ids: {
      type: "array",
      items: { type: "string" },
      description: "Event IDs to acknowledge.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum events to return for query or poll.",
    },
  },
  required: ["action"],
  additionalProperties: true,
};

function isObjectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function memoryUrl(env = process.env) {
  return String(env.OPENSHELL_MEMORY_URL || "").trim().replace(/\/+$/, "");
}

function memoryScope(env = process.env) {
  return String(env.OPENSHELL_MEMORY_SCOPE || "").trim();
}

function checkSharedMemoryRequirements(env = process.env) {
  return Boolean(memoryUrl(env) && memoryScope(env));
}

function agentId(env = process.env) {
  return env.OPENCLAW_AGENT_ID || env.AGENT_ID || "openclaw:main";
}

function sandboxId(env = process.env) {
  return env.OPENSHELL_SANDBOX_ID || env.SANDBOX_ID || os.hostname();
}

function toolError(message, extra = {}) {
  return { error: message, ...extra };
}

function coerceContent(value) {
  if (isObjectRecord(value)) return value;
  if (typeof value === "string") return { body: value };
  if (value === undefined || value === null) return {};
  return { value };
}

function appendQuery(url, query) {
  const clean = {};
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") clean[key] = String(value);
  }
  const search = new URLSearchParams(clean).toString();
  return search ? `${url}?${search}` : url;
}

function parseJsonOrText(text) {
  if (!text) return { success: true };
  try {
    return JSON.parse(text);
  } catch {
    return { success: true, response: text };
  }
}

function defaultRequestJson({ method, url, body }) {
  const parsed = new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload && Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    return Promise.resolve(
      toolError(
        `Shared memory payload is too large (${Buffer.byteLength(payload, "utf8")} bytes > ${MAX_PAYLOAD_BYTES}).`,
      ),
    );
  }

  const client = parsed.protocol === "https:" ? https : http;
  const headers = { Accept: "application/json" };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload, "utf8");
  }

  return new Promise((resolve) => {
    const request = client.request(
      parsed,
      { method, headers, timeout: DEFAULT_TIMEOUT_MS },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= MAX_PAYLOAD_BYTES) chunks.push(chunk);
          if (bytes > MAX_PAYLOAD_BYTES) response.destroy();
        });
        response.on("end", () => {
          if (bytes > MAX_PAYLOAD_BYTES) {
            resolve(toolError("Shared memory response exceeded the maximum result size."));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode && response.statusCode >= 400) {
            resolve(
              toolError(`Shared memory request failed with HTTP ${response.statusCode}.`, {
                status: response.statusCode,
                detail: text,
              }),
            );
            return;
          }
          resolve(parseJsonOrText(text));
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Shared memory request timed out.")));
    request.on("error", (error) => {
      resolve(toolError(`Shared memory endpoint is unreachable: ${error.message}`));
    });
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function createSharedMemoryTool(options = {}) {
  const env = options.env || process.env;
  const requestJson = options.requestJson || defaultRequestJson;

  async function jsonRequest(method, path, { body, query } = {}) {
    const baseUrl = memoryUrl(env);
    if (!baseUrl) return toolError("OPENSHELL_MEMORY_URL is not configured.");
    return requestJson({
      method,
      url: appendQuery(`${baseUrl}${path}`, query),
      body,
    });
  }

  return async function sharedMemoryTool(args = {}) {
    const action = String(args.action || "").trim().toLowerCase();
    if (action === "publish") {
      const eventType = String(args.event_type || "").trim();
      const subject = String(args.subject || "").trim();
      if (!eventType) return toolError("event_type is required for publish.");
      if (!subject) return toolError("subject is required for publish.");
      return jsonRequest("POST", "/memory/events", {
        body: {
          type: eventType,
          scope: memoryScope(env),
          subject,
          content: coerceContent(args.content),
          provenance: {
            agent_id: agentId(env),
            runtime: "openclaw",
            sandbox_id: sandboxId(env),
            source: args.source || "agent_observation",
          },
          visibility: args.visibility || "shared",
          sensitivity: args.sensitivity || "normal",
          schema_version: 1,
        },
      });
    }

    if (action === "query") {
      return jsonRequest("GET", "/memory/query", {
        query: {
          scope: memoryScope(env),
          type: args.event_type,
          subject: args.subject,
          agent_id: args.agent_id,
          sandbox_id: args.sandbox_id,
          limit: args.limit || 20,
        },
      });
    }

    if (action === "subscribe") {
      const subscriptionId = String(args.subscription_id || "").trim();
      if (!subscriptionId) return toolError("subscription_id is required for subscribe.");
      return jsonRequest("POST", "/memory/subscriptions", {
        body: {
          subscription_id: subscriptionId,
          subscriber: {
            agent_id: agentId(env),
            runtime: "openclaw",
            sandbox_id: sandboxId(env),
          },
          scope: memoryScope(env),
          filters: args.filters || {},
          delivery: "pull",
        },
      });
    }

    if (action === "poll") {
      const subscriptionId = String(args.subscription_id || "").trim();
      if (!subscriptionId) return toolError("subscription_id is required for poll.");
      return jsonRequest("GET", `/memory/subscriptions/${encodeURIComponent(subscriptionId)}/poll`, {
        query: { limit: args.limit || 20 },
      });
    }

    if (action === "ack") {
      const subscriptionId = String(args.subscription_id || "").trim();
      if (!subscriptionId) return toolError("subscription_id is required for ack.");
      if (!Array.isArray(args.event_ids) || args.event_ids.length === 0) {
        return toolError("event_ids must be a non-empty list for ack.");
      }
      return jsonRequest("POST", `/memory/subscriptions/${encodeURIComponent(subscriptionId)}/ack`, {
        body: { event_ids: args.event_ids },
      });
    }

    return toolError("Unknown action. Use publish, query, subscribe, poll, or ack.");
  };
}

function registerSharedMemoryTool(api) {
  const tool = {
    id: "shared_memory",
    name: "shared_memory",
    description:
      "Exchange durable scoped memory events with other agents through the OpenShell shared-memory service. Use it for cross-agent project facts, task updates, observations, and coordination state. Do not use it for secrets.",
    parameters: SHARED_MEMORY_PARAMETERS,
    inputSchema: SHARED_MEMORY_PARAMETERS,
    execute: createSharedMemoryTool(),
    handler: createSharedMemoryTool(),
  };

  if (api && typeof api.registerTool === "function") {
    api.registerTool(tool);
    return true;
  }
  if (api && api.tools && typeof api.tools.register === "function") {
    api.tools.register(tool);
    return true;
  }
  if (api && api.logger && typeof api.logger.warn === "function") {
    api.logger.warn("OpenClaw tool registration API is unavailable; shared_memory was not registered.");
  }
  return false;
}

module.exports = {
  id: "nemoclaw-shared-memory",
  name: "NemoClaw Shared Memory",
  version: "0.1.0",
  description: "Adds an OpenClaw tool for OpenShell shared memory.",
  register(api) {
    registerSharedMemoryTool(api);
  },
  createSharedMemoryTool,
  checkSharedMemoryRequirements,
  sharedMemoryTool(args, options) {
    return createSharedMemoryTool(options)(args);
  },
  __testing: {
    SHARED_MEMORY_PARAMETERS,
    appendQuery,
    coerceContent,
    createSharedMemoryTool,
    registerSharedMemoryTool,
  },
};
