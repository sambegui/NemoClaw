// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertOllamaUpgradeApplied,
  resolveOllamaInstallMenuEntry,
} from "../../../dist/lib/onboard/ollama-install-menu";
import { MIN_OLLAMA_VERSION } from "../../../dist/lib/inference/ollama-version";

const LINUX_NON_WSL = { platform: "linux" as const, isWsl: false };

describe("resolveOllamaInstallMenuEntry", () => {
  it("offers a fresh install when no Ollama is present", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(false);
    expect(result.entry?.key).toBe("install-ollama");
    expect(result.entry?.label).toBe("Install Ollama (Linux)");
  });

  it("offers an upgrade entry when host Ollama is below the minimum", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      installedOllamaVersion: "0.6.2",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.entry?.key).toBe("install-ollama");
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade installed 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("omits the entry when host Ollama meets the minimum", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      installedOllamaVersion: "0.24.0",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(false);
    expect(result.entry).toBeNull();
  });

  it("omits the entry when only Windows-host Ollama is present", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: true,
      installedOllamaVersion: null,
      ...LINUX_NON_WSL,
    });
    expect(result.entry).toBeNull();
  });

  it("treats null versions as below the minimum to recover stale installs", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade installed unknown to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("labels WSL Linux distinctly when the host is WSL", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      platform: "linux",
      isWsl: true,
    });
    expect(result.entry?.label).toBe("Install Ollama (WSL Linux)");
  });

  it("labels macOS distinctly", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      platform: "darwin",
      isWsl: false,
    });
    expect(result.entry?.label).toBe("Install Ollama (macOS)");
  });

  it("labels macOS upgrade case so the Homebrew branch can pick brew upgrade", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      installedOllamaVersion: "0.6.2",
      platform: "darwin",
      isWsl: false,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (macOS) — upgrade installed 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("treats a non-upgrade context as already applied", () => {
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: false });
    expect(result.ok).toBe(true);
  });

  it("accepts the upgrade when the post-install version meets the minimum", () => {
    const capture = () => "ollama version is 0.24.0";
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(true);
    expect(result.detectedVersion).toBe("0.24.0");
  });

  it("rejects the upgrade when the binary still reports a stale version", () => {
    const capture = () => "ollama version is 0.6.2";
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedVersion).toBe("0.6.2");
    expect(result.message).toContain("0.6.2");
    expect(result.message).toContain(MIN_OLLAMA_VERSION);
  });

  it("rejects the upgrade when ollama --version produces no parsable output", () => {
    const capture = () => "";
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedVersion).toBeNull();
    expect(result.message).toContain("unknown");
  });

  it("does not return an entry on unsupported platforms", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      platform: "win32",
      isWsl: false,
    });
    expect(result.entry).toBeNull();
  });
});
