// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { waitForHttp } from "./wait";

describe("waitForHttp", () => {
  const originalEnv = process.env;
  const tmpDirs: string[] = [];

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("bypasses proxies for loopback HTTP probes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wait-http-"));
    tmpDirs.push(tmpDir);
    const envPath = path.join(tmpDir, "curl-env.json");
    const curlPath = path.join(tmpDir, "curl");
    fs.writeFileSync(
      curlPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env));`,
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    process.env = {
      ...originalEnv,
      HTTP_PROXY: "http://127.0.0.1:8118",
      PATH: `${tmpDir}${path.delimiter}${originalEnv.PATH ?? ""}`,
    };
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    expect(waitForHttp("http://127.0.0.1:11434/", 1)).toBe(true);

    const curlEnv = JSON.parse(fs.readFileSync(envPath, "utf8"));
    expect(curlEnv.NO_PROXY).toContain("127.0.0.1");
    expect(curlEnv.NO_PROXY).toContain("localhost");
    expect(curlEnv.no_proxy).toContain("127.0.0.1");
    expect(curlEnv.no_proxy).toContain("localhost");
  });
});
