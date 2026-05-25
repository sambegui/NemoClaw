// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getInstalledOllamaVersion,
  isOllamaVersionAtLeast,
  MIN_OLLAMA_VERSION,
  type OllamaVersionRunCapture,
} from "../inference/ollama-version";

export interface OllamaInstallMenuInput {
  hasOllama: boolean;
  ollamaRunning: boolean;
  hasWindowsOllama: boolean;
  platform: NodeJS.Platform;
  isWsl: boolean;
  /** Override for tests. Defaults to a live `ollama --version` probe. */
  installedOllamaVersion?: string | null;
}

export interface OllamaInstallMenuEntry {
  key: "install-ollama";
  label: string;
}

export interface OllamaInstallMenuResult {
  entry: OllamaInstallMenuEntry | null;
  hasUpgradableOllama: boolean;
}

function osTagFor(platform: NodeJS.Platform, isWsl: boolean): string | null {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return isWsl ? "WSL Linux" : "Linux";
  return null;
}

/**
 * Decide whether the onboard provider menu should expose an `install-ollama`
 * entry, and which label to render. Two cases:
 *
 *   1. No Ollama anywhere (host, running, or Windows) — offer a fresh install
 *      as a fallback (e.g. when the NVIDIA API server is down and cloud keys
 *      are unavailable).
 *   2. Host Ollama exists but its version is below `MIN_OLLAMA_VERSION` —
 *      offer an explicit upgrade so the express setup path doesn't reuse a
 *      daemon that crashes loading newer starter models.
 */
export function resolveOllamaInstallMenuEntry(
  input: OllamaInstallMenuInput,
): OllamaInstallMenuResult {
  const installedOllamaVersion =
    input.installedOllamaVersion !== undefined
      ? input.installedOllamaVersion
      : input.hasOllama
        ? getInstalledOllamaVersion()
        : null;
  const hasUpgradableOllama =
    input.hasOllama && !isOllamaVersionAtLeast(installedOllamaVersion, MIN_OLLAMA_VERSION);
  const showEntry =
    (!input.hasOllama && !input.ollamaRunning && !input.hasWindowsOllama) || hasUpgradableOllama;
  if (!showEntry) {
    return { entry: null, hasUpgradableOllama };
  }
  const osTag = osTagFor(input.platform, input.isWsl);
  if (osTag === null) {
    return { entry: null, hasUpgradableOllama };
  }
  const labelPrefix = hasUpgradableOllama ? "Upgrade Ollama" : "Install Ollama";
  const upgradeSuffix = hasUpgradableOllama
    ? ` — upgrade installed ${installedOllamaVersion ?? "unknown"} to ≥ ${MIN_OLLAMA_VERSION}`
    : "";
  return {
    entry: { key: "install-ollama", label: `${labelPrefix} (${osTag})${upgradeSuffix}` },
    hasUpgradableOllama,
  };
}

export interface OllamaUpgradeApplied {
  ok: boolean;
  detectedVersion: string | null;
  message?: string;
}

/**
 * After the install/upgrade command, confirm the host Ollama actually
 * advanced past `MIN_OLLAMA_VERSION`. Guards against silent failures from
 * `brew upgrade ollama` (ignored exit code), user-local Linux fallbacks that
 * never replaced the running daemon, and any other path where the binary
 * remains stale.
 */
export function assertOllamaUpgradeApplied(
  menu: { hasUpgradableOllama: boolean },
  runCaptureImpl?: OllamaVersionRunCapture,
): OllamaUpgradeApplied {
  if (!menu.hasUpgradableOllama) {
    return { ok: true, detectedVersion: null };
  }
  const detectedVersion = getInstalledOllamaVersion(runCaptureImpl);
  if (isOllamaVersionAtLeast(detectedVersion, MIN_OLLAMA_VERSION)) {
    return { ok: true, detectedVersion };
  }
  const versionLabel = detectedVersion ?? "unknown";
  return {
    ok: false,
    detectedVersion,
    message:
      `Ollama upgrade did not take effect — ${versionLabel} reported after install, need ≥ ${MIN_OLLAMA_VERSION}. ` +
      "Upgrade manually (https://ollama.com/download) and rerun onboard.",
  };
}
