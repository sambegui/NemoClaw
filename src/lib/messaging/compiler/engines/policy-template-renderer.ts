// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type {
  ChannelPolicyTemplateSpec,
  MessagingAgentId,
  SandboxMessagingInputReference,
  SandboxMessagingNetworkPolicyTemplatePlan,
} from "../../manifest";

const POLICY_TEMPLATES_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "nemoclaw-blueprint",
  "policies",
  "templates",
);
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const LINE_ONLY_AGENT_BINARIES_PATTERN =
  /^([ \t]*)-\s*path:\s*["']\{\{\s*agent\.binaries\s*\}\}["'][ \t]*$/gm;

const DEFAULT_MESSAGING_BINARIES_BY_AGENT: Readonly<Record<MessagingAgentId, readonly string[]>> = {
  openclaw: ["/usr/local/bin/node", "/usr/bin/node"],
  hermes: ["/usr/local/bin/hermes", "/usr/bin/python3*", "/opt/hermes/.venv/bin/python"],
};

interface TemplateUrlContext {
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
}

export function renderPolicyTemplate(
  channelId: string,
  spec: ChannelPolicyTemplateSpec,
  agent: MessagingAgentId,
  inputs: readonly SandboxMessagingInputReference[],
): SandboxMessagingNetworkPolicyTemplatePlan | null {
  const sourceValue = inputStringValue(inputs, spec.sourceInput);
  if (!sourceValue) return null;

  const url = renderTemplateUrlContext(sourceValue, spec.sourceType);
  const binaries = spec.binariesByAgent?.[agent] ?? DEFAULT_MESSAGING_BINARIES_BY_AGENT[agent];
  const template = readPolicyTemplate(spec.templateFile);
  const rendered = renderPolicyTemplateContent(template, { url, binaries });
  const parsed = parseRenderedPolicyTemplate(spec.name, rendered);

  return {
    channelId,
    presetName: spec.name,
    templateFile: spec.templateFile,
    sourceInput: spec.sourceInput,
    policyKeys: Object.keys(parsed.network_policies),
    content: YAML.stringify(parsed),
  };
}

export function renderTemplateUrlContext(
  value: string,
  sourceType: ChannelPolicyTemplateSpec["sourceType"],
): TemplateUrlContext {
  if (sourceType !== "https-url" && sourceType !== "http-url") {
    throw new Error(`Unsupported policy template source type: ${sourceType}`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    const scheme = sourceType === "http-url" ? "HTTP or HTTPS" : "HTTPS";
    throw new Error(`Policy template URL must be an absolute ${scheme} URL.`);
  }

  if (sourceType === "https-url" && url.protocol !== "https:") {
    throw new Error("Policy template URL must use https://.");
  }
  if (sourceType === "http-url" && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Policy template URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Policy template URL must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Policy template URL must not include query strings or fragments.");
  }

  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..") || host.includes("*")) {
    throw new Error("Policy template URL host must be an exact DNS name or IPv4 address.");
  }

  return {
    host,
    port: portForUrl(url),
    basePath: normalizeUrlBasePath(url.pathname),
  };
}

function portForUrl(url: URL): number {
  const explicitPort = url.port ? Number(url.port) : undefined;
  const port = explicitPort ?? (url.protocol === "https:" ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Policy template URL port must be between 1 and 65535.");
  }
  return port;
}

function inputStringValue(
  inputs: readonly SandboxMessagingInputReference[],
  sourceInput: string,
): string | null {
  const input = inputs.find(
    (entry) => entry.inputId === sourceInput || entry.statePath === sourceInput,
  );
  const value = input?.value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrlBasePath(pathname: string): string {
  let basePath = pathname.trim().replace(/\/+$/g, "");
  if (basePath === "/" || basePath === "") return "";
  if (basePath.endsWith("/api/v4")) basePath = basePath.slice(0, -"/api/v4".length);
  if (basePath === "/" || basePath === "") return "";
  if (!basePath.startsWith("/")) basePath = `/${basePath}`;
  return basePath;
}

function readPolicyTemplate(templateFile: string): string {
  if (!templateFile || templateFile.includes("\0")) {
    throw new Error("Policy template file must be a relative YAML file path.");
  }
  const resolved = path.resolve(POLICY_TEMPLATES_DIR, templateFile);
  if (!resolved.startsWith(POLICY_TEMPLATES_DIR + path.sep) || !/\.ya?ml$/i.test(resolved)) {
    throw new Error(`Invalid policy template path: ${templateFile}`);
  }
  return fs.readFileSync(resolved, "utf-8");
}

function renderPolicyTemplateContent(
  template: string,
  context: { readonly url: TemplateUrlContext; readonly binaries: readonly string[] },
): string {
  const withBinaries = template.replace(
    LINE_ONLY_AGENT_BINARIES_PATTERN,
    (_match, indent: string) => renderAgentBinaries(indent, context.binaries),
  );
  const rendered = withBinaries.replace(TEMPLATE_TOKEN_PATTERN, (_match, token: string) => {
    switch (token) {
      case "url.host":
        return context.url.host;
      case "url.port":
        return String(context.url.port);
      case "url.basePath":
        return context.url.basePath;
      default:
        throw new Error(`Unknown policy template token: ${token}`);
    }
  });
  if (TEMPLATE_TOKEN_PATTERN.test(rendered)) {
    throw new Error("Policy template contains unresolved tokens.");
  }
  return rendered;
}

function renderAgentBinaries(indent: string, binaries: readonly string[]): string {
  if (binaries.length === 0) return `${indent}[]`;
  return binaries.map((binary) => `${indent}- { path: ${validateYamlScalar(binary)} }`).join("\n");
}

function validateYamlScalar(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error("Policy template binary paths must be non-empty single-line values.");
  }
  return value;
}

function parseRenderedPolicyTemplate(
  expectedPresetName: string,
  rendered: string,
): { preset: { name: string; description?: string }; network_policies: Record<string, unknown> } {
  const parsed = YAML.parse(rendered) as unknown;
  if (!isObject(parsed)) {
    throw new Error("Rendered policy template must be a YAML mapping.");
  }

  const preset = parsed.preset;
  if (!isObject(preset) || preset.name !== expectedPresetName) {
    throw new Error(`Rendered policy template must declare preset.name: ${expectedPresetName}`);
  }
  delete preset.template;

  const networkPolicies = parsed.network_policies;
  if (!isObject(networkPolicies) || Object.keys(networkPolicies).length === 0) {
    throw new Error("Rendered policy template must declare network_policies.");
  }
  normalizeNetworkPolicyPorts(networkPolicies);

  return parsed as {
    preset: { name: string; description?: string };
    network_policies: Record<string, unknown>;
  };
}

function normalizeNetworkPolicyPorts(networkPolicies: Record<string, unknown>): void {
  for (const policy of Object.values(networkPolicies)) {
    if (!isObject(policy) || !Array.isArray(policy.endpoints)) continue;
    for (const endpoint of policy.endpoints) {
      if (!isObject(endpoint) || typeof endpoint.port !== "string") continue;
      if (!/^[0-9]+$/.test(endpoint.port)) continue;
      const port = Number(endpoint.port);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        endpoint.port = port;
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
