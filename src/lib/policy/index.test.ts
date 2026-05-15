// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPolicyGetCommand,
  buildPolicySetCommand,
  clampSetupPolicyPresetNames,
  extractPresetEntries,
  filterSetupPolicyPresets,
  getMessagingPresetWarning,
  getPresetEndpoints,
  loadPreset,
  loadPresetFromFile,
  mergePresetIntoPolicy,
  parseCurrentPolicy,
  removePresetFromPolicy,
  setupPolicyPresetSupported,
} from "../../../dist/lib/policy/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_OPENSHELL_BIN;
});

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nemoclaw-policy-test-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("policy preset pure helpers", () => {
  it("extracts endpoint hosts and messaging warnings", () => {
    const endpoints = getPresetEndpoints(`
network_policies:
  allow_one:
    host: "api.example.com"
  allow_two:
    host: slack.com
`);
    expect(endpoints).toEqual(["api.example.com", "slack.com"]);
    expect(getMessagingPresetWarning("telegram")).toContain("Telegram");
    expect(getMessagingPresetWarning("not-messaging")).toBeNull();
  });

  it("filters setup presets based on web-search support", () => {
    const presets = [{ name: "brave" }, { name: "github" }, { name: "custom" }];
    expect(setupPolicyPresetSupported("brave", { webSearchSupported: false })).toBe(false);
    expect(setupPolicyPresetSupported("brave", { webSearchSupported: true })).toBe(true);
    expect(filterSetupPolicyPresets(presets, { webSearchSupported: false })).toEqual([
      { name: "github" },
      { name: "custom" },
    ]);
    expect(
      clampSetupPolicyPresetNames(["brave", "github", "missing", "custom"], presets, {
        webSearchSupported: false,
      }),
    ).toEqual(["github", "custom"]);
    expect(
      clampSetupPolicyPresetNames(
        ["brave", "github", "custom"],
        presets,
        { webSearchSupported: false },
        new Set(["brave"]),
      ),
    ).toEqual(["brave", "github", "custom"]);
  });

  it("parses gateway policy output defensively", () => {
    expect(parseCurrentPolicy(null)).toBe("");
    expect(parseCurrentPolicy("Version: 1\n---\nversion: 1\nnetwork_policies: {}\n")).toContain(
      "network_policies",
    );
    expect(parseCurrentPolicy("error: gateway unavailable")).toBe("");
    expect(parseCurrentPolicy("just some text")).toBe("");
    expect(parseCurrentPolicy("version: [")).toBe("");
  });

  it("extracts network policy entries from preset YAML", () => {
    expect(extractPresetEntries(null)).toBeNull();
    expect(extractPresetEntries("preset:\n  name: demo\n")).toBeNull();
    expect(
      extractPresetEntries(`preset:
  name: demo
network_policies:
  demo:
    host: example.com
`),
    ).toBe("  demo:\n    host: example.com");
  });

  it("builds policy commands with the configured OpenShell binary", () => {
    process.env.NEMOCLAW_OPENSHELL_BIN = "/opt/openshell";
    expect(buildPolicyGetCommand("alpha")).toEqual(["/opt/openshell", "policy", "get", "--full", "alpha"]);
    expect(buildPolicySetCommand("/tmp/policy.yaml", "alpha")).toEqual([
      "/opt/openshell",
      "policy",
      "set",
      "--policy",
      "/tmp/policy.yaml",
      "--wait",
      "alpha",
    ]);
  });
});

describe("policy preset merge/remove helpers", () => {
  const presetEntries = `  allow_api:
    host: api.example.com
    port: 443
`;

  it("merges structured preset entries into empty and existing policies", () => {
    expect(mergePresetIntoPolicy("", presetEntries)).toContain("allow_api");
    const merged = mergePresetIntoPolicy(
      `Version: 1
---
version: 2
filesystem_policy:
  read_only: true
network_policies:
  keep_me:
    host: keep.example.com
`,
      presetEntries,
    );
    expect(merged).toContain("filesystem_policy");
    expect(merged).toContain("keep_me");
    expect(merged).toContain("allow_api");
  });

  it("handles versionless policies and legacy non-map network policies while merging", () => {
    const versionless = mergePresetIntoPolicy("filesystem_policy:\n  read_only: true\n", presetEntries);
    expect(versionless).toMatch(/^version: 1/m);
    expect(versionless).toContain("filesystem_policy");
    expect(versionless).toContain("allow_api");

    const legacyList = mergePresetIntoPolicy("version: 2\nnetwork_policies:\n  - legacy\n", presetEntries);
    expect(legacyList).toContain("version: 2");
    expect(legacyList).toContain("allow_api");
    expect(legacyList).not.toContain("- legacy");
  });

  it("lets preset entries override existing network policy keys", () => {
    const merged = mergePresetIntoPolicy(
      `version: 1
network_policies:
  allow_api:
    host: old.example.com
    port: 80
`,
      presetEntries,
    );
    expect(merged).toContain("host: api.example.com");
    expect(merged).toContain("port: 443");
    expect(merged).not.toContain("old.example.com");
  });

  it("falls back to text merging for unparseable preset entries", () => {
    expect(mergePresetIntoPolicy("version: 1\n", "  - not-a-map")).toContain("network_policies:");
    expect(mergePresetIntoPolicy("", "")).toBe("version: 1\n\nnetwork_policies:\n");
  });

  it("removes structured preset entries from existing policies", () => {
    const current = `version: 1
network_policies:
  allow_api:
    host: api.example.com
  keep_me:
    host: keep.example.com
`;
    const removed = removePresetFromPolicy(current, presetEntries);
    expect(removed).not.toContain("allow_api");
    expect(removed).toContain("keep_me");
    expect(removePresetFromPolicy(current, null)).toBe(current.trimEnd());
    expect(removePresetFromPolicy("", presetEntries)).toBe("version: 1\n\nnetwork_policies:\n");
  });

  it("leaves removal unchanged for legacy non-map policies and unparsable current policy", () => {
    const legacyList = "version: 1\nnetwork_policies:\n  - legacy\n";
    expect(removePresetFromPolicy(legacyList, presetEntries)).toBe(legacyList.trimEnd());
    expect(removePresetFromPolicy("version: [", presetEntries)).toBe("version: 1\n\nnetwork_policies:\n");
  });

  it("leaves policies unchanged when preset entries cannot identify keys", () => {
    const current = "version: 1\nnetwork_policies:\n  keep_me:\n    host: keep.example.com\n";
    expect(removePresetFromPolicy(current, "  - not-a-map")).toBe(current);
  });
});

describe("loadPresetFromFile", () => {
  it("loads a valid custom preset file", () => {
    const file = tempFile(
      "custom.yaml",
      `preset:
  name: custom-egress
network_policies:
  custom_egress:
    host: custom.example.com
`,
    );
    expect(loadPresetFromFile(file)).toEqual({
      presetName: "custom-egress",
      content: expect.stringContaining("custom.example.com"),
    });
  });

  it("rejects invalid custom preset files", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));

    expect(loadPresetFromFile(tempFile("not-text.txt", "preset:\n  name: bad\n"))).toBeNull();
    expect(loadPresetFromFile(join(tmpdir(), "missing-policy.yaml"))).toBeNull();
    expect(loadPresetFromFile(tempFile("bad.yaml", "preset: ["))).toBeNull();
    expect(loadPresetFromFile(tempFile("array.yaml", "- item\n"))).toBeNull();
    expect(loadPresetFromFile(tempFile("missing-name.yaml", "network_policies: {}\n"))).toBeNull();
    expect(
      loadPresetFromFile(tempFile("missing-network.yaml", "preset:\n  name: custom-egress\n")),
    ).toBeNull();

    expect(errors.join("\n")).toContain("Preset file must be .yaml or .yml");
    expect(errors.join("\n")).toContain("Preset file not found");
    expect(errors.join("\n")).toContain("Invalid YAML");
    expect(errors.join("\n")).toContain("Preset must be a YAML mapping");
    expect(errors.join("\n")).toContain("Preset must declare preset.name");
    expect(errors.join("\n")).toContain("Preset missing network_policies section");
  });

  it("keeps built-in presets on the built-in path", () => {
    expect(loadPreset("../../etc/passwd")).toBeNull();
    expect(loadPreset("definitely-missing-preset")).toBeNull();
  });
});
