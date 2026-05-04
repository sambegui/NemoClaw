// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- pure helper tests exercise this module; full CI source-map accounting is unstable. */

export type SandboxImageRow = { tag: string; size: string };

export function parseSandboxImageRows(imagesOutput: string): SandboxImageRow[] {
  const rows: SandboxImageRow[] = [];
  for (const rawLine of imagesOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [tag, size] = line.split("\t");
    rows.push({ tag, size: size || "unknown" });
  }
  return rows;
}

export function getRegisteredImageTags(
  sandboxes: Array<{ imageTag?: string | null }>,
): Set<string> {
  const registeredTags = new Set<string>();
  for (const sandbox of sandboxes) {
    if (sandbox.imageTag) registeredTags.add(sandbox.imageTag);
  }
  return registeredTags;
}

export function findOrphanedSandboxImages(
  images: SandboxImageRow[],
  sandboxes: Array<{ imageTag?: string | null }>,
): SandboxImageRow[] {
  const registeredTags = getRegisteredImageTags(sandboxes);
  const orphans: SandboxImageRow[] = [];
  for (const image of images) {
    if (!registeredTags.has(image.tag)) {
      orphans.push(image);
    }
  }
  return orphans;
}

export function hasSandboxImages(images: readonly SandboxImageRow[]): boolean {
  return images.length > 0;
}

export function hasOrphanedSandboxImages(images: readonly SandboxImageRow[]): boolean {
  return images.length > 0;
}

export function formatSandboxImageRow(
  image: SandboxImageRow,
  style: { dim?: string; reset?: string } = {},
): string {
  return `${image.tag}  ${style.dim ?? ""}(${image.size})${style.reset ?? ""}`;
}

/* v8 ignore stop */
