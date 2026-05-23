#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary NemoClaw compatibility shim for OpenClaw 2026.5.x chat.send
 * gateway behavior. Remove this when upstream OpenClaw preserves submitted
 * chat.send run lineage and stops emitting empty terminal chat events.
 */

const fs = require("node:fs");
const path = require("node:path");

const distDir = process.argv[2];
if (!distDir) {
  console.error("Usage: patch-openclaw-chat-send.js <openclaw-dist-dir>");
  process.exit(2);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function listJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(dir, entry.name));
}

function patchChatSendFile(file) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;

  if (!source.includes("nemoclaw: correlate chat.send run ids")) {
    const next = source.replace(
      /(onAgentRunStart: \(runId\) => \{\n)(\s*)agentRunStarted = true;/,
      (_match, prefix, indent) =>
        `${prefix}${indent}agentRunStarted = true;\n` +
        `${indent}if (runId && runId !== clientRunId) context.addChatRun(runId, { sessionKey, clientRunId }); ` +
        `// nemoclaw: correlate chat.send run ids (#2603, #3145)`,
    );
    if (next === source) {
      fail(`OpenClaw chat.send run-start shape not recognized in ${file}`);
    }
    source = next;
  }

  if (!source.includes("idempotencyKey: clientRunId")) {
    let inserted = false;
    source = source.replace(
      /(createIfMissing: true,\n)(\s*)(ttsSupplement: ttsSupplementMarker,)/g,
      (match, prefix, indent, ttsLine, offset) => {
        const preceding = source.slice(Math.max(0, offset - 300), offset);
        if (preceding.includes("idempotencyKey:")) return match;
        inserted = true;
        return `${prefix}${indent}idempotencyKey: clientRunId,\n${indent}${ttsLine}`;
      },
    );
    if (!inserted) {
      fail(`OpenClaw chat.send transcript append shape not recognized in ${file}`);
    }
  }

  if (!source.includes("suppressing empty final event")) {
    const next = source.replace(
      /\n(\s*)broadcastChatFinal\(\{\n(\s*)context,\n\s*runId: clientRunId,\n\s*sessionKey,\n\s*message\n\s*\}\);/,
      (
        _match,
        outerIndent,
        innerIndent,
      ) =>
        `\n${outerIndent}if (message) broadcastChatFinal({\n` +
        `${innerIndent}context,\n` +
        `${innerIndent}runId: clientRunId,\n` +
        `${innerIndent}sessionKey,\n` +
        `${innerIndent}message\n` +
        `${outerIndent}}); else context.logGateway.warn("webchat chat.send completed without visible assistant reply; suppressing empty final event (nemoclaw #2603/#3145)");`,
    );
    if (next === source) {
      fail(`OpenClaw chat.send empty-final shape not recognized in ${file}`);
    }
    source = next;
  }

  if (source !== original) {
    fs.writeFileSync(file, source);
    return true;
  }
  return false;
}

const candidates = listJsFiles(distDir).filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return source.includes('"chat.send"') && source.includes("onAgentRunStart");
});

if (candidates.length !== 1) {
  fail(`expected exactly one OpenClaw chat.send runtime file, found ${candidates.length}`);
}

const chatFile = candidates[0];
patchChatSendFile(chatFile);

const patched = fs.readFileSync(chatFile, "utf8");
if (!patched.includes("nemoclaw: correlate chat.send run ids")) {
  fail("chat.send run-id correlation patch did not apply");
}
if (!patched.includes("idempotencyKey: clientRunId")) {
  fail("chat.send transcript idempotency patch did not apply");
}
if (!patched.includes("suppressing empty final event")) {
  fail("chat.send empty-final suppression patch did not apply");
}

console.log(`INFO: patched OpenClaw chat.send compatibility in ${path.basename(chatFile)}`);
