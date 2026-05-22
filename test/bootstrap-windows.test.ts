// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const BOOTSTRAP_WINDOWS = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "bootstrap-windows.ps1",
);

function readBootstrapWindows() {
  return fs.readFileSync(BOOTSTRAP_WINDOWS, "utf8");
}

describe("Windows bootstrap WSL distro preflight", () => {
  it("defaults fresh Windows hosts to the Ubuntu 24.04 distro required by N1X", () => {
    const script = readBootstrapWindows();

    expect(script).toContain("[string]$DistroName = 'Ubuntu-24.04'");
  });

  it("installs a missing WSL distro before handing off to the shell installer", () => {
    const script = readBootstrapWindows();

    expect(script).toContain("function Install-WslDistro");
    expect(script).toContain(
      "$installExitCode = Invoke-NativeCommand -FilePath $wsl -ArgumentList @('--install', $Name)",
    );
    expect(script).toContain("Wait-WslDistroRegistration -Name $Name");
    expect(script).not.toContain("InstallDistroAtHandoff");
  });

  it("keeps the no-distro failure actionable for issue 3974", () => {
    const script = readBootstrapWindows();

    expect(script).toContain("NemoClaw on Windows ARM requires WSL2 Ubuntu 24.04.");
    expect(script).toContain("Please run: wsl --install Ubuntu-24.04");
    expect(script).toContain("Then re-run this installer.");
  });
});
