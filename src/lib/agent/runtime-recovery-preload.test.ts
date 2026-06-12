// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildOpenClawRecoveryScript, buildRecoveryScript } from "../../../dist/lib/agent/runtime";
import type { AgentDefinition } from "./defs";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    displayName: "Test Agent",
    binary_path: "/usr/local/bin/test-agent",
    gateway_command: "test-agent gateway run",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    inferenceProviderOptions: [],
    stateDirs: [],
    stateFiles: [],
    versionCommand: "test-agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    messagingPlatforms: [],
    dockerfileBasePath: null,
    dockerfilePath: null,
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/tmp/agent",
    manifestPath: "/tmp/agent/manifest.yaml",
    ...overrides,
  };
}

const minimalAgent = makeAgent();

const PRELOAD_BASENAMES = ["sandbox-safety-net", "ciao-network-guard"] as const;
const SELF_HEAL_RE =
  /if \[ "\$_PE_MISSING" = "0" \]; then .+?_nemoclaw_install_recovery_preload \/tmp\/nemoclaw-ciao-network-guard\.js \/usr\/local\/lib\/nemoclaw\/preloads\/ciao-network-guard\.js \|\| true; fi;/;

interface Fixture {
  dir: string;
  tmpDir: string;
  sourceDir: string;
  tmpPaths: Record<(typeof PRELOAD_BASENAMES)[number], string>;
  sourcePaths: Record<(typeof PRELOAD_BASENAMES)[number], string>;
  selfHeal: string;
}

function makeFixture(script: string): Fixture {
  const match = script.match(SELF_HEAL_RE);
  expect(match, "self-heal block not found in script").toBeTruthy();
  const block = match![0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-self-heal-"));
  const tmpDir = path.join(dir, "tmp");
  const sourceDir = path.join(dir, "src");
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(sourceDir);
  const tmpPaths: Record<string, string> = {};
  const sourcePaths: Record<string, string> = {};
  for (const base of PRELOAD_BASENAMES) {
    tmpPaths[base] = path.join(tmpDir, `nemoclaw-${base}.js`);
    sourcePaths[base] = path.join(sourceDir, `${base}.js`);
  }
  let rewritten = block;
  for (const base of PRELOAD_BASENAMES) {
    rewritten = rewritten
      .replaceAll(`/tmp/nemoclaw-${base}.js`, tmpPaths[base])
      .replaceAll(`/usr/local/lib/nemoclaw/preloads/${base}.js`, sourcePaths[base]);
  }
  return {
    dir,
    tmpDir,
    sourceDir,
    tmpPaths: tmpPaths as Fixture["tmpPaths"],
    sourcePaths: sourcePaths as Fixture["sourcePaths"],
    selfHeal: rewritten,
  };
}

function cleanFixture(fx: Fixture): void {
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

function writeSource(fx: Fixture): void {
  for (const base of PRELOAD_BASENAMES) {
    fs.writeFileSync(fx.sourcePaths[base], `// trusted source for ${base}\n`);
  }
}

function runProbe(
  fx: Fixture,
  options: { peMissing?: "0" | "1"; seedNodeOptions?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const peMissing = options.peMissing ?? "0";
  const seed = options.seedNodeOptions ?? "";
  const probe = [
    `_GATEWAY_LOG=${JSON.stringify(path.join(fx.dir, "gateway.log"))};`,
    `_PE_MISSING=${peMissing};`,
    seed ? `export NODE_OPTIONS=${JSON.stringify(seed)};` : "export NODE_OPTIONS='';",
    fx.selfHeal,
    `printf '%s' "$NODE_OPTIONS"`,
  ].join(" ");
  const result = spawnSync("bash", ["-c", probe], {
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("gateway recovery preload self-heal (#5253)", () => {
  describe("generated script shape", () => {
    it("defines the installer shell function", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("_nemoclaw_install_recovery_preload() {");
    });

    it("gates the whole self-heal block on _PE_MISSING=0", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toMatch(SELF_HEAL_RE);
    });

    it("references the immutable /usr/local/lib/nemoclaw/preloads source paths", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js");
      expect(script).toContain("/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js");
    });

    it("orders self-heal after proxy-env source and before the guard refusal", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toBeNull();
      const sourceIdx = script!.indexOf("then . /tmp/nemoclaw-proxy-env.sh");
      const selfHealIdx = script!.indexOf('if [ "$_PE_MISSING" = "0" ]; then _nemoclaw_install');
      const guardIdx = script!.indexOf("_GUARDS_MISSING=1");
      const refusalIdx = script!.indexOf("refusing unguarded gateway relaunch");
      expect(sourceIdx).toBeGreaterThanOrEqual(0);
      expect(selfHealIdx).toBeGreaterThan(sourceIdx);
      expect(guardIdx).toBeGreaterThan(selfHealIdx);
      expect(refusalIdx).toBeGreaterThan(guardIdx);
    });

    it("orders self-heal correctly in the OpenClaw recovery script as well", () => {
      const script = buildOpenClawRecoveryScript(18789);
      const sourceIdx = script.indexOf("then . /tmp/nemoclaw-proxy-env.sh");
      const selfHealIdx = script.indexOf('if [ "$_PE_MISSING" = "0" ]; then _nemoclaw_install');
      const refusalIdx = script.indexOf("refusing unguarded gateway relaunch");
      expect(sourceIdx).toBeGreaterThanOrEqual(0);
      expect(selfHealIdx).toBeGreaterThan(sourceIdx);
      expect(refusalIdx).toBeGreaterThan(selfHealIdx);
    });

    it("refuses to copy from /tmp file via [ -r ] alone — installer validates provenance", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("is a symlink - refusing preload install");
      expect(script).toContain("has unsafe mode=");
      expect(script).toContain("owner=$owner (expected root)");
    });

    it("final guard check matches the trusted --require path, not just the marker substring", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain(
        '*"--require /tmp/nemoclaw-sandbox-safety-net.js"*) _SN_MISSING=0 ;;',
      );
      expect(script).toContain(
        '*"--require /tmp/nemoclaw-ciao-network-guard.js"*) _CIAO_MISSING=0 ;;',
      );
      expect(script).not.toContain("*nemoclaw-sandbox-safety-net*) _SN_MISSING=0 ;;");
      expect(script).not.toContain("*nemoclaw-ciao-network-guard*) _CIAO_MISSING=0 ;;");
    });

    it("OpenClaw recovery also pins the guard check to the trusted --require path", () => {
      const script = buildOpenClawRecoveryScript(18789);
      expect(script).toContain(
        '*"--require /tmp/nemoclaw-sandbox-safety-net.js"*) _SN_MISSING=0 ;;',
      );
      expect(script).toContain(
        '*"--require /tmp/nemoclaw-ciao-network-guard.js"*) _CIAO_MISSING=0 ;;',
      );
    });
  });

  describe("behavioural — install from trusted source", () => {
    it("regenerates both /tmp preloads when missing, given trusted source files", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        writeSource(fx);
        const result = runProbe(fx);
        expect(result.status, result.stderr).toBe(0);
        for (const base of PRELOAD_BASENAMES) {
          expect(fs.existsSync(fx.tmpPaths[base])).toBe(true);
          expect(result.stdout).toContain(`--require ${fx.tmpPaths[base]}`);
          const stat = fs.statSync(fx.tmpPaths[base]);
          const mode = (stat.mode & 0o777).toString(8);
          expect(mode).toBe("444");
        }
      } finally {
        cleanFixture(fx);
      }
    });

    it("reuses a pre-existing /tmp preload that already has mode 444", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        writeSource(fx);
        for (const base of PRELOAD_BASENAMES) {
          fs.writeFileSync(fx.tmpPaths[base], "// already staged\n");
          fs.chmodSync(fx.tmpPaths[base], 0o444);
        }
        const beforeMtimes = PRELOAD_BASENAMES.map(
          (base) => fs.statSync(fx.tmpPaths[base]).mtimeMs,
        );
        const result = runProbe(fx);
        expect(result.status, result.stderr).toBe(0);
        for (const base of PRELOAD_BASENAMES) {
          expect(result.stdout).toContain(`--require ${fx.tmpPaths[base]}`);
        }
        const afterMtimes = PRELOAD_BASENAMES.map((base) => fs.statSync(fx.tmpPaths[base]).mtimeMs);
        expect(afterMtimes).toEqual(beforeMtimes);
        for (const base of PRELOAD_BASENAMES) {
          expect(fs.readFileSync(fx.tmpPaths[base], "utf-8")).toBe("// already staged\n");
        }
      } finally {
        cleanFixture(fx);
      }
    });
  });

  describe("behavioural — provenance refusals", () => {
    it("refuses a symlinked /tmp preload and does not graft it into NODE_OPTIONS", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        writeSource(fx);
        const decoy = path.join(fx.dir, "attacker.js");
        fs.writeFileSync(decoy, "// attacker payload\n");
        fs.symlinkSync(decoy, fx.tmpPaths["sandbox-safety-net"]);
        fs.writeFileSync(fx.tmpPaths["ciao-network-guard"], "// staged\n");
        fs.chmodSync(fx.tmpPaths["ciao-network-guard"], 0o444);
        const result = runProbe(fx);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain(fx.tmpPaths["sandbox-safety-net"]);
        expect(result.stdout).toContain(`--require ${fx.tmpPaths["ciao-network-guard"]}`);
        expect(result.stderr).toContain("is a symlink - refusing preload install");
      } finally {
        cleanFixture(fx);
      }
    });

    it("refuses a /tmp preload whose mode is not 444", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        writeSource(fx);
        fs.writeFileSync(fx.tmpPaths["sandbox-safety-net"], "// tampered\n");
        fs.chmodSync(fx.tmpPaths["sandbox-safety-net"], 0o666);
        fs.writeFileSync(fx.tmpPaths["ciao-network-guard"], "// staged\n");
        fs.chmodSync(fx.tmpPaths["ciao-network-guard"], 0o444);
        const result = runProbe(fx);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain(fx.tmpPaths["sandbox-safety-net"]);
        expect(result.stdout).toContain(`--require ${fx.tmpPaths["ciao-network-guard"]}`);
        expect(result.stderr).toContain("has unsafe mode=666");
      } finally {
        cleanFixture(fx);
      }
    });

    it("warns and skips when both the /tmp copy and the trusted source are missing", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        const result = runProbe(fx);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("missing - cannot self-heal");
        const log = fs.readFileSync(path.join(fx.dir, "gateway.log"), "utf-8");
        expect(log).toContain("missing - cannot self-heal");
      } finally {
        cleanFixture(fx);
      }
    });
  });

  describe("behavioural — NODE_OPTIONS handling", () => {
    it("treats a marker substring without --require as not-yet-installed and adds it", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        writeSource(fx);
        const result = runProbe(fx, { seedNodeOptions: "nemoclaw-sandbox-safety-net" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`--require ${fx.tmpPaths["sandbox-safety-net"]}`);
        expect(result.stdout).toContain(`--require ${fx.tmpPaths["ciao-network-guard"]}`);
      } finally {
        cleanFixture(fx);
      }
    });

    it("does not duplicate --require entries that are already present", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        writeSource(fx);
        for (const base of PRELOAD_BASENAMES) {
          fs.writeFileSync(fx.tmpPaths[base], "// staged\n");
          fs.chmodSync(fx.tmpPaths[base], 0o444);
        }
        const seed = `--require ${fx.tmpPaths["sandbox-safety-net"]} --require ${fx.tmpPaths["ciao-network-guard"]}`;
        const result = runProbe(fx, { seedNodeOptions: seed });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(seed);
      } finally {
        cleanFixture(fx);
      }
    });

    it("skips the whole self-heal block when _PE_MISSING=1", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      const fx = makeFixture(script!);
      try {
        writeSource(fx);
        const result = runProbe(fx, { peMissing: "1" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("");
        for (const base of PRELOAD_BASENAMES) {
          expect(fs.existsSync(fx.tmpPaths[base])).toBe(false);
        }
      } finally {
        cleanFixture(fx);
      }
    });
  });
});
