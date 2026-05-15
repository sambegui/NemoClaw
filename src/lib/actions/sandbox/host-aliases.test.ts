// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const dockerExecFileSync = vi.fn();

let addSandboxHostAlias: typeof import("../../../../dist/lib/actions/sandbox/host-aliases").addSandboxHostAlias;
let listSandboxHostAliases: typeof import("../../../../dist/lib/actions/sandbox/host-aliases").listSandboxHostAliases;
let removeSandboxHostAlias: typeof import("../../../../dist/lib/actions/sandbox/host-aliases").removeSandboxHostAlias;

function loadActionsWithMockedDocker(): void {
  const dockerPath = require.resolve("../../../../dist/lib/adapters/docker");
  const actionPath = require.resolve("../../../../dist/lib/actions/sandbox/host-aliases");
  delete require.cache[dockerPath];
  delete require.cache[actionPath];
  require.cache[dockerPath] = {
    id: dockerPath,
    filename: dockerPath,
    loaded: true,
    exports: { dockerExecFileSync },
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
  ({ addSandboxHostAlias, listSandboxHostAliases, removeSandboxHostAlias } = require(actionPath));
}

function sandboxResource(hostAliases: unknown[] = [], resourceVersion = "7"): string {
  return JSON.stringify({
    metadata: { resourceVersion },
    spec: { podTemplate: { spec: { hostAliases } } },
  });
}

describe("sandbox host alias actions", () => {
  let logs: string[];
  let errors: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    errors = [];
    dockerExecFileSync.mockReset();
    loadActionsWithMockedDocker();
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists empty host aliases", () => {
    dockerExecFileSync.mockReturnValueOnce(sandboxResource([]));

    listSandboxHostAliases("alpha");

    expect(logs).toEqual(["  No host aliases configured for 'alpha'."]);
    expect(dockerExecFileSync).toHaveBeenCalledWith(
      [
        "openshell-cluster-nemoclaw",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "sandbox",
        "alpha",
        "-o",
        "json",
      ],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("lists configured host aliases", () => {
    dockerExecFileSync.mockReturnValueOnce(
      sandboxResource([{ ip: "192.168.1.10", hostnames: ["search.local", "api.local"] }]),
    );

    listSandboxHostAliases("alpha");

    expect(logs).toEqual([
      "  Host aliases for 'alpha':",
      "    192.168.1.10  search.local, api.local",
    ]);
  });

  it("previews add patches with normalized hostnames", () => {
    dockerExecFileSync.mockReturnValueOnce(sandboxResource([], "42"));

    addSandboxHostAlias("alpha", ["Search.Local", "192.168.1.10", "--dry-run"]);

    const patch = JSON.parse(logs[0]);
    expect(patch).toEqual([
      { op: "test", path: "/metadata/resourceVersion", value: "42" },
      {
        op: "replace",
        path: "/spec/podTemplate/spec/hostAliases",
        value: [{ ip: "192.168.1.10", hostnames: ["search.local"] }],
      },
    ]);
  });

  it("previews remove patches and drops empty IP entries", () => {
    dockerExecFileSync.mockReturnValueOnce(
      sandboxResource([
        { ip: "192.168.1.10", hostnames: ["search.local"] },
        { ip: "192.168.1.11", hostnames: ["api.local", "admin.local"] },
      ]),
    );

    removeSandboxHostAlias("alpha", ["API.Local", "--dry-run"]);

    const patch = JSON.parse(logs[0]);
    expect(patch.at(-1)).toEqual({
      op: "replace",
      path: "/spec/podTemplate/spec/hostAliases",
      value: [
        { ip: "192.168.1.10", hostnames: ["search.local"] },
        { ip: "192.168.1.11", hostnames: ["admin.local"] },
      ],
    });
  });

  it("rejects malformed add requests before reading cluster state", () => {
    expect(() => addSandboxHostAlias("alpha", ["bad_host", "192.168.1.10"])).toThrow("exit:1");
    expect(errors).toContain("  Invalid hostname 'bad_host'.");
    expect(dockerExecFileSync).not.toHaveBeenCalled();

    errors = [];
    expect(() => addSandboxHostAlias("alpha", ["search.local", "not-an-ip"])).toThrow("exit:1");
    expect(errors).toContain("  Invalid IP address 'not-an-ip'.");
  });

  it("rejects duplicate aliases case-insensitively", () => {
    dockerExecFileSync.mockReturnValueOnce(
      sandboxResource([{ ip: "192.168.1.10", hostnames: ["search.local"] }]),
    );

    expect(() => addSandboxHostAlias("alpha", ["SEARCH.Local", "192.168.1.11"])).toThrow(
      "exit:1",
    );

    expect(errors).toContain("  Host alias 'search.local' already exists.");
  });

  it("reports invalid sandbox resource JSON", () => {
    dockerExecFileSync.mockReturnValueOnce("not json");

    expect(() => listSandboxHostAliases("alpha")).toThrow("exit:1");

    expect(errors.join("\n")).toContain("Failed to parse sandbox resource");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
