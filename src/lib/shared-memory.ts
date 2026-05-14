// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const SHARED_MEMORY_BACKEND_REDIS = "redis";
export const DEFAULT_SHARED_MEMORY_ENDPOINT = "http://memory.local/v1";

const DISABLED_SHARED_MEMORY_VALUES = new Set(["", "0", "false", "off", "none", "disabled"]);
const SCOPE_RE = /^(user|workspace|project|sandbox):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SharedMemoryBackend = typeof SHARED_MEMORY_BACKEND_REDIS;

export interface SharedMemoryRuntimeConfig {
  backend: SharedMemoryBackend;
  scope: string;
  endpoint: string;
  redisUrl: string;
}

export interface SharedMemoryRegistryMetadata {
  backend: SharedMemoryBackend;
  scope: string;
  endpoint: string;
}

function normalizeEnvValue(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateRedisUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OPENSHELL_MEMORY_REDIS_URL must be a valid redis:// or rediss:// URL.");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("OPENSHELL_MEMORY_REDIS_URL must use redis:// or rediss://.");
  }
  if (!parsed.hostname) {
    throw new Error("OPENSHELL_MEMORY_REDIS_URL must include a host.");
  }
  return parsed.toString();
}

function validateEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OPENSHELL_MEMORY_URL must be a valid http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OPENSHELL_MEMORY_URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OPENSHELL_MEMORY_URL must not contain credentials.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function validateScope(value: string): string {
  if (!SCOPE_RE.test(value)) {
    throw new Error(
      "NEMOCLAW_SHARED_MEMORY_SCOPE must look like workspace:nemoclaw, project:NemoClaw, user:aniket, or sandbox:demo.",
    );
  }
  return value;
}

export function resolveSharedMemoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): SharedMemoryRuntimeConfig | null {
  const requestedBackend = normalizeEnvValue(env.NEMOCLAW_SHARED_MEMORY).toLowerCase();
  if (DISABLED_SHARED_MEMORY_VALUES.has(requestedBackend)) {
    return null;
  }
  if (requestedBackend !== SHARED_MEMORY_BACKEND_REDIS) {
    throw new Error(
      "Unsupported shared memory backend. Set NEMOCLAW_SHARED_MEMORY=redis or unset it.",
    );
  }

  const redisUrl = normalizeEnvValue(env.OPENSHELL_MEMORY_REDIS_URL);
  if (!redisUrl) {
    throw new Error("OPENSHELL_MEMORY_REDIS_URL is required when NEMOCLAW_SHARED_MEMORY=redis.");
  }

  const scope = normalizeEnvValue(env.NEMOCLAW_SHARED_MEMORY_SCOPE);
  if (!scope) {
    throw new Error("NEMOCLAW_SHARED_MEMORY_SCOPE is required when shared memory is enabled.");
  }

  return {
    backend: SHARED_MEMORY_BACKEND_REDIS,
    scope: validateScope(scope),
    endpoint: validateEndpoint(
      normalizeEnvValue(env.OPENSHELL_MEMORY_URL) || DEFAULT_SHARED_MEMORY_ENDPOINT,
    ),
    redisUrl: validateRedisUrl(redisUrl),
  };
}

export function buildSharedMemorySandboxEnv(
  config: SharedMemoryRuntimeConfig | null,
): Record<string, string> {
  if (!config) return {};
  return {
    NEMOCLAW_SHARED_MEMORY: "1",
    OPENSHELL_MEMORY_BACKEND: config.backend,
    OPENSHELL_MEMORY_SCOPE: config.scope,
    OPENSHELL_MEMORY_URL: config.endpoint,
  };
}

export function toSharedMemoryRegistryMetadata(
  config: SharedMemoryRuntimeConfig | null,
): SharedMemoryRegistryMetadata | undefined {
  if (!config) return undefined;
  return {
    backend: config.backend,
    scope: config.scope,
    endpoint: config.endpoint,
  };
}

export function sharedMemoryRegistryMetadataEqual(
  left: SharedMemoryRegistryMetadata | null | undefined,
  right: SharedMemoryRegistryMetadata | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.backend === right.backend &&
    left.scope === right.scope &&
    left.endpoint === right.endpoint
  );
}

export function hasSharedMemoryRegistryDrift(
  existing: SharedMemoryRegistryMetadata | null | undefined,
  desired: SharedMemoryRegistryMetadata | null | undefined,
): boolean {
  return !sharedMemoryRegistryMetadataEqual(existing, desired);
}

export function formatSharedMemorySummary(
  metadata: SharedMemoryRegistryMetadata | SharedMemoryRuntimeConfig,
): string {
  return `${metadata.backend} scope=${metadata.scope} endpoint=${metadata.endpoint}`;
}
