// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  findOrphanedSandboxImages,
  formatSandboxImageRow,
  getRegisteredImageTags,
  hasOrphanedSandboxImages,
  hasSandboxImages,
  parseSandboxImageRows,
} from "./maintenance-image-helpers";

describe("maintenance image helpers", () => {
  it("parses Docker image rows and fills missing sizes", () => {
    expect(
      parseSandboxImageRows("openshell/sandbox-from:one\t1GB\nopenshell/sandbox-from:two\n\n"),
    ).toEqual([
      { tag: "openshell/sandbox-from:one", size: "1GB" },
      { tag: "openshell/sandbox-from:two", size: "unknown" },
    ]);
  });

  it("collects registered sandbox image tags", () => {
    expect(
      getRegisteredImageTags([
        { imageTag: "openshell/sandbox-from:one" },
        { imageTag: null },
        {},
      ]),
    ).toEqual(new Set(["openshell/sandbox-from:one"]));
  });

  it("finds orphaned sandbox images by registry image tags", () => {
    const orphans = findOrphanedSandboxImages(
      [
        { tag: "openshell/sandbox-from:one", size: "1GB" },
        { tag: "openshell/sandbox-from:two", size: "2GB" },
      ],
      [{ imageTag: "openshell/sandbox-from:one" }, { imageTag: null }],
    );

    expect(hasSandboxImages(orphans)).toBe(true);
    expect(hasOrphanedSandboxImages(orphans)).toBe(true);
    expect(orphans).toEqual([{ tag: "openshell/sandbox-from:two", size: "2GB" }]);
  });

  it("formats sandbox image rows for display", () => {
    expect(formatSandboxImageRow({ tag: "openshell/sandbox-from:one", size: "1GB" })).toBe(
      "openshell/sandbox-from:one  (1GB)",
    );
    expect(
      formatSandboxImageRow({ tag: "openshell/sandbox-from:one", size: "1GB" }, { dim: "<d>", reset: "</>" }),
    ).toBe("openshell/sandbox-from:one  <d>(1GB)</>");
  });
});
