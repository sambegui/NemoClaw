// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Reusable WSL orchestration for Windows-hosted GitHub Actions jobs. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportEnv, optionalEnv, requireEnv, setOutput, shellQuote } from "./lib/actions.ts";
import { runCapture, runChecked } from "./lib/exec.ts";
import { isMainModule } from "./lib/module.ts";

export function windowsPathToWsl(winPath: string): string {
  const driveMatch = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!driveMatch) {
    throw new Error(`Expected an absolute Windows path with a drive letter, got: ${winPath}`);
  }
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replaceAll("\\", "/");
  return `/mnt/${drive}/${rest}`;
}

function distro(): string {
  return optionalEnv("WSL_DISTRO", "Ubuntu");
}

function wsl(args: readonly string[]): ReturnType<typeof runCapture> {
  return runCapture("wsl", args);
}

function wslChecked(args: readonly string[]): void {
  runChecked("wsl", args);
}

function assertWindowsHost(): void {
  if (process.platform !== "win32") {
    throw new Error("scripts/github/wsl.ts must be run on a Windows GitHub Actions runner.");
  }
}

function sleep(milliseconds: number): void {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1000, end - Date.now()));
  }
}

function writeBashScript(script: string): string {
  const tempRoot = optionalEnv("RUNNER_TEMP", os.tmpdir());
  const dir = mkdtempSync(path.join(tempRoot, "nemoclaw-wsl-step-"));
  const scriptPath = path.join(dir, "step.sh");
  writeFileSync(scriptPath, script.replaceAll("\r\n", "\n"), { encoding: "utf-8" });
  return scriptPath;
}

function windowsPathToWslViaDistro(winPath: string): string {
  const normalized = winPath.replaceAll("\\", "/");
  const result = wsl(["-d", distro(), "--", "wslpath", "-u", normalized]);
  if (result.status !== 0) {
    throw new Error(`wslpath failed for ${winPath}:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function withWslEnv<T>(names: readonly string[], callback: () => T): T {
  if (names.length === 0) {
    return callback();
  }

  const previous = process.env.WSLENV;
  const existing = new Set((previous ?? "").split(":").filter(Boolean));
  for (const name of names) {
    existing.add(name);
  }
  process.env.WSLENV = [...existing].join(":");
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.WSLENV;
    } else {
      process.env.WSLENV = previous;
    }
  }
}

function runBashInWsl(script: string, passEnv: readonly string[] = []): void {
  const scriptPath = writeBashScript(script);
  try {
    const wslScriptPath = windowsPathToWslViaDistro(scriptPath);
    withWslEnv(passEnv, () => wslChecked(["-d", distro(), "--", "bash", "-l", wslScriptPath]));
  } finally {
    rmSync(path.dirname(scriptPath), { force: true, recursive: true });
  }
}

function resolvePaths(): void {
  assertWindowsHost();
  const workspace = requireEnv("GITHUB_WORKSPACE");
  const prefix = optionalEnv("WSL_WORKDIR_PREFIX", "/tmp/nemoclaw-wsl-workdir");
  const runId = requireEnv("GITHUB_RUN_ID");
  const attempt = optionalEnv("GITHUB_RUN_ATTEMPT", "1");
  const checkoutDir = windowsPathToWsl(workspace);
  const workdir = `${prefix}/${runId}-${attempt}`;
  exportEnv("WSL_CHECKOUT_DIR", checkoutDir);
  exportEnv("WSL_WORKDIR", workdir);
  console.log(`WSL_CHECKOUT_DIR=${checkoutDir}`);
  console.log(`WSL_WORKDIR=${workdir}`);
}

function distroAvailable(): boolean {
  return wsl(["-d", distro(), "--", "echo", "ok"]).status === 0;
}

function normalizeWslMessage(message: string): string {
  return message.replaceAll("\u0000", "").toLowerCase();
}

function listDistributions(): void {
  const result = wsl(["--list", "--verbose"]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status === 0) {
    return;
  }

  const message = normalizeWslMessage(`${result.stdout}\n${result.stderr}`);
  if (message.includes("no installed distributions")) {
    console.log("No WSL distributions are installed yet; continuing with Ubuntu installation.");
    return;
  }

  throw new Error(`wsl --list --verbose failed with exit code ${result.status}`);
}

function ensureUbuntu(): void {
  assertWindowsHost();
  listDistributions();
  if (!distroAvailable()) {
    const maxAttempts = 3;
    let installed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      console.log(
        `Ubuntu not found - installing via wsl --install (attempt ${attempt}/${maxAttempts})`,
      );
      const install = wsl(["--install", "-d", distro(), "--no-launch", "--web-download"]);
      if (install.status === 0) {
        const launch = wsl(["-d", distro(), "--", "bash", "-c", "echo distro initialised"]);
        if (launch.status === 0) {
          installed = true;
          break;
        }
        console.warn(`distro first-launch failed with exit code ${launch.status}`);
      } else {
        console.warn(`wsl --install failed with exit code ${install.status}`);
      }

      if (distroAvailable()) {
        console.log("Ubuntu became available after the install command returned non-zero");
        installed = true;
        break;
      }

      if (attempt < maxAttempts) {
        console.log("Cleaning up any partial WSL registration before retrying");
        wsl(["--unregister", distro()]);
        const delaySeconds = Math.min(60, 20 * attempt);
        console.log(`Retrying WSL install in ${delaySeconds} seconds...`);
        sleep(delaySeconds * 1000);
      }
    }
    if (!installed) {
      throw new Error(`failed to install and initialize ${distro()} after ${maxAttempts} attempts`);
    }
  } else {
    console.log("Ubuntu already available");
  }
  wslChecked(["--set-default", distro()]);
}

function verify(): void {
  wslChecked(["-d", distro(), "--", "bash", "-lc", "uname -a"]);
  wslChecked(["-d", distro(), "--", "bash", "-lc", "cat /etc/os-release"]);
}

function installUbuntuDeps(): void {
  const installDocker = optionalEnv("WSL_INSTALL_DOCKER") === "1";
  runBashInWsl(`
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
printf '%s\n' \
  'Acquire::ForceIPv4 "true";' \
  'Acquire::Retries "5";' \
  >/etc/apt/apt.conf.d/99github-actions-network
apt-get update
apt-get install -y bash ca-certificates curl git jq lsb-release make python3 python3-pip rsync tar unzip xz-utils
${
  installDocker
    ? `if ! docker info >/dev/null 2>&1; then
  apt-get install -y docker.io
  service docker start || /etc/init.d/docker start || true
  timeout 30 bash -c 'until docker info >/dev/null 2>&1; do sleep 2; done'
fi
docker --version
docker info >/dev/null`
    : ""
}
`);
}

function installNode(): void {
  runBashInWsl(`
set -euo pipefail
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version
npm --version
`);
}

function copyCheckout(): void {
  const checkout = requireEnv("WSL_CHECKOUT_DIR");
  const workdir = requireEnv("WSL_WORKDIR");
  const parent = workdir.slice(0, workdir.lastIndexOf("/"));
  runBashInWsl(`
set -euo pipefail
echo 'Syncing checkout from ${checkout} to ${workdir}'
if [ ! -d ${shellQuote(`${checkout}/.git`)} ]; then
  echo 'Expected a Git checkout at ${checkout}' >&2
  exit 1
fi
rm -rf ${shellQuote(workdir)}
mkdir -p ${shellQuote(parent)}
rsync -a --no-owner --no-group --delete \
  --exclude '/node_modules/' \
  --exclude '/nemoclaw/node_modules/' \
  --exclude '/nemoclaw-blueprint/.venv/' \
  ${shellQuote(`${checkout}/`)} ${shellQuote(`${workdir}/`)}
git config --global --add safe.directory ${shellQuote(workdir)}
git -C ${shellQuote(workdir)} reset --hard HEAD
git -C ${shellQuote(workdir)} clean -ffdx
git -C ${shellQuote(workdir)} status --short
echo 'WSL ext4 workspace ready at ${workdir}'
`);
}

export function npmInstallCommandForMode(mode: string): string {
  if (mode === "install") {
    return "npm install --ignore-scripts";
  }
  if (mode === "ci") {
    return "npm ci --ignore-scripts";
  }
  throw new Error(`Unsupported WSL_NPM_INSTALL_MODE: ${mode}`);
}

function installProject(): void {
  const workdir = requireEnv("WSL_WORKDIR");
  const npmInstallCommand = npmInstallCommandForMode(optionalEnv("WSL_NPM_INSTALL_MODE", "ci"));
  runBashInWsl(`
set -euo pipefail
cd ${shellQuote(workdir)}
${npmInstallCommand}
npm run build:cli
cd nemoclaw
${npmInstallCommand}
npm run build
`);
}

function installRootAndRenderCoverage(): void {
  const workdir = requireEnv("WSL_WORKDIR");
  runBashInWsl(`
set -euo pipefail
cd ${shellQuote(workdir)}
npm ci --ignore-scripts
mkdir -p .e2e
bash test/e2e/runtime/coverage-report.sh > .e2e/coverage.md
`);
}

function dockerAvailable(): void {
  const result = wsl(["-d", distro(), "--", "bash", "-lc", "docker info >/dev/null 2>&1"]);
  const available = result.status === 0;
  setOutput("docker_ok", available);
  console.log(available ? "Docker is available in WSL" : "Docker is not available in WSL");
}

function runFullE2E(): void {
  const workdir = requireEnv("WSL_WORKDIR");
  runBashInWsl(
    `
set -euo pipefail
cd ${shellQuote(workdir)}
export NVIDIA_API_KEY="\${NVIDIA_API_KEY:-}"
export GITHUB_TOKEN="\${GITHUB_TOKEN:-}"
export NEMOCLAW_NON_INTERACTIVE="\${NEMOCLAW_NON_INTERACTIVE:-1}"
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="\${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-1}"
export NEMOCLAW_RECREATE_SANDBOX="\${NEMOCLAW_RECREATE_SANDBOX:-1}"
export NEMOCLAW_SANDBOX_NAME="\${NEMOCLAW_SANDBOX_NAME:-e2e-wsl}"
bash test/e2e/test-full-e2e.sh
`,
    [
      "NVIDIA_API_KEY",
      "GITHUB_TOKEN",
      "NEMOCLAW_NON_INTERACTIVE",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      "NEMOCLAW_RECREATE_SANDBOX",
      "NEMOCLAW_SANDBOX_NAME",
    ],
  );
}

function runVitest(): void {
  const workdir = requireEnv("WSL_WORKDIR");
  runBashInWsl(`
set -euo pipefail
cd ${shellQuote(workdir)}
export NEMOCLAW_EXEC_TIMEOUT=60000
export NEMOCLAW_TEST_TIMEOUT=60000
npx vitest run --testTimeout 60000
`);
}

function runScenario(): void {
  const workdir = requireEnv("WSL_WORKDIR");
  const scenario = requireEnv("SCENARIO");
  runBashInWsl(
    `
set -euo pipefail
cd ${shellQuote(workdir)}
export NVIDIA_API_KEY="\${NVIDIA_API_KEY:-}"
export E2E_SUITE_FILTER="\${E2E_SUITE_FILTER:-}"
export NEMOCLAW_RECREATE_SANDBOX="\${NEMOCLAW_RECREATE_SANDBOX:-1}"
bash test/e2e/runtime/run-scenario.sh ${shellQuote(scenario)}
`,
    ["NVIDIA_API_KEY", "E2E_SUITE_FILTER", "NEMOCLAW_RECREATE_SANDBOX"],
  );
}

function copyArtifactsToCheckout(): void {
  const checkout = requireEnv("WSL_CHECKOUT_DIR");
  const workdir = requireEnv("WSL_WORKDIR");
  runBashInWsl(`
set -euo pipefail
mkdir -p ${shellQuote(`${checkout}/.e2e`)} ${shellQuote(`${checkout}/test/e2e/logs`)}
if [ -d ${shellQuote(`${workdir}/.e2e`)} ]; then
  rsync -a ${shellQuote(`${workdir}/.e2e/`)} ${shellQuote(`${checkout}/.e2e/`)}
fi
if [ -d ${shellQuote(`${workdir}/test/e2e/logs`)} ]; then
  rsync -a ${shellQuote(`${workdir}/test/e2e/logs/`)} ${shellQuote(`${checkout}/test/e2e/logs/`)}
fi
`);
}

const COMMANDS = new Map<string, () => void>([
  ["resolve-paths", resolvePaths],
  ["ensure-ubuntu", ensureUbuntu],
  ["verify", verify],
  ["install-ubuntu-deps", installUbuntuDeps],
  ["install-node", installNode],
  ["copy-checkout", copyCheckout],
  ["install-project", installProject],
  ["install-root-and-render-coverage", installRootAndRenderCoverage],
  ["docker-available", dockerAvailable],
  ["run-full-e2e", runFullE2E],
  ["run-vitest", runVitest],
  ["run-scenario", runScenario],
  ["copy-artifacts-to-checkout", copyArtifactsToCheckout],
]);

function main(): void {
  const command = process.argv[2];
  const handler = command === undefined ? undefined : COMMANDS.get(command);
  if (!handler) {
    throw new Error(`Unknown WSL helper command: ${command ?? "<missing>"}`);
  }
  handler();
}

if (isMainModule(import.meta.url)) {
  main();
}
