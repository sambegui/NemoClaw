// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const tmpHomes: string[] = [];

afterEach(() => {
  for (const dir of tmpHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runGenerator(env: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-config-"));
  tmpHomes.push(home);
  const script = path.join(
    process.cwd(),
    "agents",
    "langchain-deepagents-code",
    "generate-config.ts",
  );
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      ...env,
    },
  });
  expect(result.status).toBe(0);
  return fs.readFileSync(path.join(home, ".deepagents", "config.toml"), "utf8");
}

describe("LangChain Deep Agents Code config generator", () => {
  it("routes managed inference through OpenAI-compatible chat completions", () => {
    const config = runGenerator({});

    expect(config).toContain('default = "openai:nvidia/nemotron-3-super-120b-a12b"');
    expect(config).toContain('api_key_env = "DEEPAGENTS_CODE_OPENAI_API_KEY"');
    expect(config).toContain('base_url = "https://inference.local/v1"');
    expect(config).toContain("use_responses_api = false");
    expect(config).toContain("auto_update = false");
    expect(config).not.toMatch(/NVIDIA_API_KEY|OPENAI_API_KEY=|sk-/);
  });

  it("does not double-prefix provider-qualified model names", () => {
    const config = runGenerator({ NEMOCLAW_MODEL: "openai:gpt-oss-120b" });

    expect(config).toContain('default = "openai:gpt-oss-120b"');
    expect(config).toContain('models = ["gpt-oss-120b"]');
  });
});
