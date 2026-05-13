// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function gpuPassthroughRecoveryLines(registeredNames: readonly string[]): string[] {
  const lines: string[] = ["  Existing gateway was started without GPU passthrough."];
  if (registeredNames.length === 0) {
    lines.push("  No sandboxes are registered, so there is nothing to destroy.");
    lines.push("  To enable GPU, clear the stale gateway state and re-onboard:");
    lines.push("    nemoclaw uninstall && nemoclaw onboard --gpu");
    return lines;
  }
  const plural = registeredNames.length === 1 ? "" : "es";
  const list = registeredNames.map((n) => `\`${n}\``).join(", ");
  lines.push(`  To enable GPU, destroy the registered sandbox${plural} (${list}) and re-onboard:`);
  for (const name of registeredNames) lines.push(`    nemoclaw ${name} destroy --yes`);
  lines.push("    nemoclaw onboard --gpu");
  return lines;
}

function defaultRegisteredSandboxNames(): readonly string[] {
  try {
    const registry = require("../state/registry") as typeof import("../state/registry");
    return registry.listSandboxes().sandboxes.map((s) => s.name).filter(Boolean);
  } catch {
    return [];
  }
}

export function reportGpuPassthroughRecovery(
  emit: (line: string) => void = console.error,
  listRegisteredSandboxes: () => readonly string[] = defaultRegisteredSandboxNames,
): void {
  let names: readonly string[] = [];
  try {
    names = listRegisteredSandboxes();
  } catch {
    names = [];
  }
  for (const line of gpuPassthroughRecoveryLines(names)) emit(line);
}
