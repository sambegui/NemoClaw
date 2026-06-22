// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-openclaw-discord-pairing.sh. */

import fs from "node:fs";

import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  applyFakePolicy,
  approveAndAssertPairing,
  assertOpenClawStateRoot,
  cleanupPairingSandbox,
  DISCORD_DM_CHANNEL,
  extractPairingCode,
  issuePairingRequest,
  PAIRING_USER,
  pairingEnv,
  pairingRedactions,
  runDiscordGatewayProof,
  startFakeDiscordGateway,
  writePairingArtifacts,
} from "./openclaw-pairing-helpers.ts";
import {
  dockerInfo,
  expectExitZero,
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  resultText,
  sandboxSh,
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-openclaw-discord-pairing";
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "test-fake-discord-pairing-e2e";
const LIVE_TIMEOUT_MS = 55 * 60_000;

function assertDiscordGatewayCapture(captureFile: string): void {
  const rows = fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const identify = rows.filter((row) => row.event === "identify").at(-1);
  expect(identify, "fake Discord Gateway did not capture IDENTIFY").toBeTruthy();
  expect(identify?.tokenMatchesExpected, "Discord token rewrite").toBe(true);
  expect(identify?.tokenLooksPlaceholder, "Discord placeholder leaked").toBe(false);
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "OpenClaw Discord pairing request is shared with connect-shell approval",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const env = pairingEnv({
      sandboxName: SANDBOX_NAME,
      apiKey,
      channel: "discord",
      discordToken: DISCORD_TOKEN,
    });
    const redactions = pairingRedactions({ apiKey, discordToken: DISCORD_TOKEN });

    await artifacts.writeJson("scenario.json", {
      id: "openclaw-discord-pairing",
      legacySource: "test/e2e/test-openclaw-discord-pairing.sh",
      boundary:
        "install.sh Discord OpenClaw sandbox + fake Discord Gateway token rewrite + runtime pairing request + connect-shell approval",
      sandboxName: SANDBOX_NAME,
      pairingUser: PAIRING_USER.discord,
      dmChannel: DISCORD_DM_CHANNEL,
    });

    cleanup.add(`destroy Discord pairing sandbox ${SANDBOX_NAME}`, () =>
      cleanupPairingSandbox(host, SANDBOX_NAME, env, redactions, "cleanup-discord-pairing"),
    );
    await cleanupPairingSandbox(host, SANDBOX_NAME, env, redactions, "preclean-discord-pairing");

    const docker = await dockerInfo(host, env);
    expect(docker.exitCode, resultText(docker)).toBe(0);

    const install = await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "install-discord-pairing",
      skip,
      "NVIDIA endpoint validation was rate-limited before Discord pairing assertions ran",
    );
    expectExitZero(install, "install.sh --non-interactive with Discord");
    await expectSandboxReady(host, SANDBOX_NAME, env, redactions, "sandbox-list-discord-pairing");

    const provider = await host.command(
      "openshell",
      ["provider", "get", `${SANDBOX_NAME}-discord-bridge`],
      {
        artifactName: "provider-get-discord-pairing",
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      },
    );
    expectExitZero(provider, "Discord provider exists");

    const config = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      `python3 - <<'PY'\nimport json\ncfg=json.load(open('/sandbox/.openclaw/openclaw.json'))\naccount=(cfg.get('channels',{}).get('discord',{}).get('accounts',{}).get('default') or {})\nprint(json.dumps({'token': account.get('token',''), 'dmPolicy': account.get('dmPolicy',''), 'allowFrom': account.get('allowFrom', [])}))\nPY`,
      { artifactName: "discord-openclaw-config", redactionValues: redactions },
    );
    expectExitZero(config, "Discord OpenClaw config");
    expect(config.stdout).toContain("openshell:resolve:env:");
    expect(config.stdout).toContain("DISCORD_BOT_TOKEN");
    expect(config.stdout).not.toContain('"dmPolicy": "allowlist"');

    await assertOpenClawStateRoot(sandbox, SANDBOX_NAME, "discord", redactions);

    const fakeGateway = await startFakeDiscordGateway(
      host,
      cleanup,
      env,
      DISCORD_TOKEN,
      redactions,
    );
    await applyFakePolicy({
      host,
      sandboxName: SANDBOX_NAME,
      api: fakeGateway,
      protocol: "websocket",
      rewrite: "websocket-credential-rewrite",
      env,
      redactions,
      artifactName: "apply-discord-gateway-policy",
    });
    const gatewayProof = await runDiscordGatewayProof({
      sandbox,
      sandboxName: SANDBOX_NAME,
      port: fakeGateway.port,
      redactions,
    });
    expectExitZero(gatewayProof, "Discord Gateway protocol proof");
    expect(resultText(gatewayProof)).toContain("UPGRADE");
    expect(resultText(gatewayProof)).toContain("HELLO");
    expect(resultText(gatewayProof)).toContain("IDENTIFY_SENT_PLACEHOLDER");
    expect(resultText(gatewayProof)).toContain("READY");
    expect(resultText(gatewayProof)).toContain("HEARTBEAT_ACK");
    assertDiscordGatewayCapture(fakeGateway.captureFile);

    const issue = await issuePairingRequest({
      sandbox,
      sandboxName: SANDBOX_NAME,
      channel: "discord",
      redactions,
    });
    expectExitZero(issue, "Discord pairing request creation");
    const code = extractPairingCode(resultText(issue), "DISCORD_PAIRING_E2E_RESULT");
    await writePairingArtifacts(artifacts, "discord", { code, user: PAIRING_USER.discord });

    await approveAndAssertPairing({
      sandbox,
      sandboxName: SANDBOX_NAME,
      channel: "discord",
      code,
      redactions,
    });
  },
);
