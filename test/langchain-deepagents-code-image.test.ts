// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

function makeStartScriptFixture(tempDir: string): { envFile: string; scriptPath: string } {
  const envFile = path.join(tempDir, "proxy-env.sh");
  const scriptPath = path.join(tempDir, "start.sh");
  const fixture = readAgentFile("start.sh")
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${envFile}"`)
    .replace(
      'tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
      `tmp="$(mktemp "${tempDir}/nemoclaw-proxy-env.XXXXXX")"`,
    );
  fs.writeFileSync(scriptPath, fixture, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return { envFile, scriptPath };
}

describe("LangChain Deep Agents Code image contracts", () => {
  it("hardens copied NemoClaw blueprints against sandbox-user mutation", () => {
    const dockerfile = readAgentFile("Dockerfile");

    expect(dockerfile).toContain("chown root:root /sandbox/.nemoclaw");
    expect(dockerfile).toContain("chmod 1755 /sandbox/.nemoclaw");
    expect(dockerfile).toContain("chown -R root:root /sandbox/.nemoclaw/blueprints");
    expect(dockerfile).toContain("chmod -R 755 /sandbox/.nemoclaw/blueprints");
    expect(dockerfile.indexOf("cp -r /opt/nemoclaw-blueprint/*")).toBeLessThan(
      dockerfile.indexOf("chown -R root:root /sandbox/.nemoclaw/blueprints"),
    );
  });

  it("does not serialize provider or optional service secrets into the shell env file", () => {
    const startScript = readAgentFile("start.sh");

    expect(startScript).toContain('chmod 400 "$tmp"');
    expect(startScript).toContain("write_proxy_export_if_set HTTPS_PROXY");
    expect(startScript).not.toContain("write_export_if_set DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(startScript).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(startScript).not.toMatch(
      /write_export_if_set (?:NVIDIA_API_KEY|OPENAI_API_KEY|TAVILY_API_KEY|DEEPAGENTS_CODE_TAVILY_API_KEY|LANGSMITH_API_KEY)\b/,
    );
  });

  it("omits credential-bearing proxy URLs from the shell env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    const { envFile, scriptPath } = makeStartScriptFixture(tempDir);

    execFileSync("bash", [scriptPath, "sh", "-c", 'cat "$NEMOCLAW_TEST_PROXY_ENV"'], {
      env: {
        NEMOCLAW_TEST_PROXY_ENV: envFile,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HTTP_PROXY: "http://proxy.example:8080",
        HTTPS_PROXY: "https://user:pass@proxy.example:8443",
        http_proxy: "user:pass@proxy.example:8080",
        https_proxy: "https://safe-proxy.example:8443",
        NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST: "all",
      },
      encoding: "utf8",
    });

    const envFileText = fs.readFileSync(envFile, "utf8");
    expect(envFileText).toContain("export HTTP_PROXY=http://proxy.example:8080");
    expect(envFileText).toContain("export https_proxy=https://safe-proxy.example:8443");
    expect(envFileText).not.toContain("HTTPS_PROXY");
    expect(envFileText).not.toContain("http_proxy");
    expect(envFileText).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(envFileText).not.toContain("DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(envFileText).not.toContain("user:pass");
    expect(envFileText).not.toContain("user:pass@proxy.example:8443");
    expect(envFileText).not.toContain("user:pass@proxy.example:8080");
  });

  it("keeps all Deep Agents Code entry points behind the managed wrapper boundary", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const policy = readAgentFile("policy-additions.yaml");

    expect(dockerfile).toContain("rm -f /usr/local/bin/dcode /usr/local/bin/deepagents-code");
    expect(dockerfile).toContain("patch-managed-deepagents-code.py");
    expect(dockerfile).not.toContain("NEMOCLAW_WEB_SEARCH_ENABLED");
    expect(wrapper).toContain("unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(wrapper).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(dockerfile).toContain(
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/bin/dcode.real",
    );
    expect(dockerfile).toContain(
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/bin/deepagents-code",
    );
    expect(dockerfile).not.toContain("dcode.upstream");
    expect(wrapper).toContain("exec python3 -m deepagents_code");
    expect(wrapper).toContain('reject_managed_override "sandbox isolation"');
    expect(wrapper).toContain('reject_managed_override "MCP posture"');
    expect(wrapper).toContain('reject_managed_override "shell allow-list posture"');
    expect(wrapper).toContain("extra_args=(--sandbox none --no-mcp)");
    expect(policy).not.toContain("/usr/local/bin/dcode.real");
    expect(policy).not.toContain("dcode.upstream");
  });

  it("patches direct module execution back to NemoClaw managed posture", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-patch-"));
    const packageDir = path.join(tempDir, "deepagents_code");
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
    fs.writeFileSync(
      path.join(packageDir, "main.py"),
      [
        "import os",
        "",
        "def parse_args():",
        "    args = parser.parse_args()",
        "    return args",
        "",
      ].join("\n"),
      "utf8",
    );

    execFileSync("python3", [path.join(agentDir, "patch-managed-deepagents-code.py")], {
      env: { ...process.env, PYTHONPATH: tempDir },
    });

    const patched = fs.readFileSync(path.join(packageDir, "main.py"), "utf8");
    expect(patched).toContain('args.sandbox = "none"');
    expect(patched).toContain("args.no_mcp = True");
    expect(patched).toContain("args.mcp_config = None");
    expect(patched).toContain("args.shell_allow_list = None");
    expect(patched).toContain('os.environ.pop("DEEPAGENTS_CODE_SHELL_ALLOW_LIST", None)');
    expect(patched).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(patched).toContain('getattr(args, "command", None) == "mcp"');
  });
});
