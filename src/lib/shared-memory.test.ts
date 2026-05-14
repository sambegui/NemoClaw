// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildSharedMemorySandboxEnv,
  formatSharedMemorySummary,
  hasSharedMemoryRegistryDrift,
  resolveSharedMemoryConfig,
  toSharedMemoryRegistryMetadata,
} from "./shared-memory";

describe("shared memory configuration", () => {
  it("is disabled when NEMOCLAW_SHARED_MEMORY is unset", () => {
    expect(resolveSharedMemoryConfig({})).toBeNull();
  });

  it("resolves Redis configuration with the default OpenShell memory endpoint", () => {
    const config = resolveSharedMemoryConfig({
      NEMOCLAW_SHARED_MEMORY: "redis",
      OPENSHELL_MEMORY_REDIS_URL: "redis://127.0.0.1:6379",
      NEMOCLAW_SHARED_MEMORY_SCOPE: "workspace:nemoclaw",
    });

    expect(config).toEqual({
      backend: "redis",
      endpoint: "http://memory.local/v1",
      redisUrl: "redis://127.0.0.1:6379",
      scope: "workspace:nemoclaw",
    });
  });

  it("rejects unsupported backends", () => {
    expect(() =>
      resolveSharedMemoryConfig({ NEMOCLAW_SHARED_MEMORY: "sqlite" }),
    ).toThrow(/Unsupported shared memory backend/);
  });

  it("requires a Redis URL for Redis mode", () => {
    expect(() =>
      resolveSharedMemoryConfig({
        NEMOCLAW_SHARED_MEMORY: "redis",
        NEMOCLAW_SHARED_MEMORY_SCOPE: "workspace:nemoclaw",
      }),
    ).toThrow(/OPENSHELL_MEMORY_REDIS_URL is required/);
  });

  it("requires an explicit sharing scope", () => {
    expect(() =>
      resolveSharedMemoryConfig({
        NEMOCLAW_SHARED_MEMORY: "redis",
        OPENSHELL_MEMORY_REDIS_URL: "redis://127.0.0.1:6379",
      }),
    ).toThrow(/NEMOCLAW_SHARED_MEMORY_SCOPE is required/);
  });

  it("rejects invalid scopes", () => {
    expect(() =>
      resolveSharedMemoryConfig({
        NEMOCLAW_SHARED_MEMORY: "redis",
        OPENSHELL_MEMORY_REDIS_URL: "redis://127.0.0.1:6379",
        NEMOCLAW_SHARED_MEMORY_SCOPE: "global",
      }),
    ).toThrow(/NEMOCLAW_SHARED_MEMORY_SCOPE must look like/);
  });

  it("rejects endpoint credentials before passing endpoint metadata to sandboxes", () => {
    expect(() =>
      resolveSharedMemoryConfig({
        NEMOCLAW_SHARED_MEMORY: "redis",
        OPENSHELL_MEMORY_REDIS_URL: "redis://127.0.0.1:6379",
        OPENSHELL_MEMORY_URL: "http://user:pass@memory.local/v1",
        NEMOCLAW_SHARED_MEMORY_SCOPE: "workspace:nemoclaw",
      }),
    ).toThrow(/OPENSHELL_MEMORY_URL must not contain credentials/);
  });

  it("builds sandbox environment without the Redis credential URL", () => {
    const config = resolveSharedMemoryConfig({
      NEMOCLAW_SHARED_MEMORY: "redis",
      OPENSHELL_MEMORY_REDIS_URL: "redis://:secret@redis.local:6379/0",
      OPENSHELL_MEMORY_URL: "https://memory.local/v1/",
      NEMOCLAW_SHARED_MEMORY_SCOPE: "project:NemoClaw",
    });

    expect(buildSharedMemorySandboxEnv(config)).toEqual({
      NEMOCLAW_SHARED_MEMORY: "1",
      OPENSHELL_MEMORY_BACKEND: "redis",
      OPENSHELL_MEMORY_SCOPE: "project:NemoClaw",
      OPENSHELL_MEMORY_URL: "https://memory.local/v1",
    });
  });

  it("persists only non-secret metadata", () => {
    const config = resolveSharedMemoryConfig({
      NEMOCLAW_SHARED_MEMORY: "redis",
      OPENSHELL_MEMORY_REDIS_URL: "redis://:secret@redis.local:6379/0",
      NEMOCLAW_SHARED_MEMORY_SCOPE: "workspace:nemoclaw",
    });

    expect(toSharedMemoryRegistryMetadata(config)).toEqual({
      backend: "redis",
      endpoint: "http://memory.local/v1",
      scope: "workspace:nemoclaw",
    });
  });

  it("detects registry metadata drift", () => {
    expect(
      hasSharedMemoryRegistryDrift(
        { backend: "redis", endpoint: "http://memory.local/v1", scope: "workspace:one" },
        { backend: "redis", endpoint: "http://memory.local/v1", scope: "workspace:two" },
      ),
    ).toBe(true);
    expect(
      hasSharedMemoryRegistryDrift(
        { backend: "redis", endpoint: "http://memory.local/v1", scope: "workspace:one" },
        { backend: "redis", endpoint: "http://memory.local/v1", scope: "workspace:one" },
      ),
    ).toBe(false);
  });

  it("formats summaries without Redis credentials", () => {
    const config = resolveSharedMemoryConfig({
      NEMOCLAW_SHARED_MEMORY: "redis",
      OPENSHELL_MEMORY_REDIS_URL: "redis://:secret@redis.local:6379/0",
      NEMOCLAW_SHARED_MEMORY_SCOPE: "workspace:nemoclaw",
    });

    expect(formatSharedMemorySummary(config!)).toBe(
      "redis scope=workspace:nemoclaw endpoint=http://memory.local/v1",
    );
  });
});
