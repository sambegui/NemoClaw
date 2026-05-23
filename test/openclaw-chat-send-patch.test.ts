// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-chat-send.js",
);

function writeChatSendFixture(dist: string): string {
  const fixture = path.join(dist, "chat-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const chatHandlers = {',
      '  "chat.send": async ({ params, respond, context, client }) => {',
      "    const p = params;",
      "    const clientRunId = p.idempotencyKey;",
      '    const sessionKey = "issue2603";',
      "    let agentRunStarted = false;",
      "    measureDiagnosticsTimelineSpan(\"gateway.chat_send.dispatch_inbound\", () => dispatchInboundMessage({",
      "      replyOptions: {",
      "        runId: clientRunId,",
      "        onAgentRunStart: (runId) => {",
      "          agentRunStarted = true;",
      "          if (!hasBeforeAgentRunGate) emitUserTranscriptUpdate();",
      "        }",
      "      }",
      "    })).then(async () => {",
      "      if (!agentRunStarted) {",
      "        let message;",
      "        if (transcriptReply || persistedContentForAppend?.length || assistantContent?.length) {",
      "          const appended = await appendAssistantTranscriptMessage({",
      "            message: transcriptReply,",
      "            sessionId,",
      "            storePath: latestStorePath,",
      "            sessionFile: latestEntry?.sessionFile,",
      "            agentId,",
      "            createIfMissing: true,",
      "            ttsSupplement: ttsSupplementMarker,",
      "            cfg",
      "          });",
      "          message = appended.message;",
      "        }",
      "        broadcastChatFinal({",
      "          context,",
      "          runId: clientRunId,",
      "          sessionKey,",
      "          message",
      "        });",
      "      }",
      "    });",
      "  }",
      "};",
      "",
    ].join("\n"),
  );
  return fixture;
}

function runPatch(dist: string) {
  return spawnSync(process.execPath, [PATCH_SCRIPT, dist], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

describe("OpenClaw chat.send compatibility patch", () => {
  it("correlates agent runs, idempotently appends transcripts, and suppresses empty finals", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-chat-send-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    const fixture = writeChatSendFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("patched OpenClaw chat.send compatibility");

      const patched = fs.readFileSync(fixture, "utf-8");
      expect(patched).toContain(
        "context.addChatRun(runId, { sessionKey, clientRunId }); // nemoclaw: correlate chat.send run ids (#2603, #3145)",
      );
      expect(patched).toContain("idempotencyKey: clientRunId");
      expect(patched).toContain("if (message) broadcastChatFinal({");
      expect(patched).toContain("suppressing empty final event");

      const rerun = runPatch(dist);
      expect(rerun.status, `${rerun.stdout}${rerun.stderr}`).toBe(0);
      const rerunPatched = fs.readFileSync(fixture, "utf-8");
      expect(rerunPatched.match(/context\.addChatRun\(runId/g)).toHaveLength(1);
      expect(rerunPatched.match(/idempotencyKey: clientRunId/g)).toHaveLength(1);
      expect(rerunPatched.match(/suppressing empty final event/g)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the OpenClaw chat.send source shape changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-chat-send-missing-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "chat-fixture.js"), 'const handlers = { "chat.send": true };\n');

    try {
      const patch = runPatch(dist);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("expected exactly one OpenClaw chat.send runtime file");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
