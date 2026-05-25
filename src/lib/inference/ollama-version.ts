// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ollama version detection helpers. Kept separate from the larger
 * `inference/local.ts` so the version-floor logic can evolve without
 * dragging the rest of the local-inference helpers along.
 */

const { runCapture } = require("../runner");

export type OllamaVersionRunCapture = (
  cmd: readonly string[],
  opts?: { ignoreError?: boolean },
) => string;

/**
 * Minimum Ollama version NemoClaw expects when reusing an existing host
 * Ollama. Older Ollama runners crash loading newer starter models because
 * their GGUF parsers predate the model format. Bump this when starter-model
 * recipes adopt a newer GGUF feature.
 */
export const MIN_OLLAMA_VERSION = "0.7.0";

export function getInstalledOllamaVersion(
  runCaptureImpl?: OllamaVersionRunCapture,
): string | null {
  const capture = runCaptureImpl ?? runCapture;
  const out = capture(["ollama", "--version"], { ignoreError: true });
  if (!out) return null;
  const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match[0] : null;
}

export function isOllamaVersionAtLeast(
  version: string | null,
  minimum: string,
): boolean {
  if (!version) return false;
  const parts = version.split(".").map((v) => Number.parseInt(v, 10));
  const min = minimum.split(".").map((v) => Number.parseInt(v, 10));
  const len = Math.max(parts.length, min.length);
  for (let i = 0; i < len; i += 1) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}
