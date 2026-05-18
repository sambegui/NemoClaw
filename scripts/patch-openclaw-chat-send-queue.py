#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Patch pinned OpenClaw chat.send to serialize WebChat/TUI turns per session.

This is intentionally shape-checked against OpenClaw 2026.4.24's compiled dist.
It should fail closed when the bundled OpenClaw implementation changes.
"""

from __future__ import annotations

import sys
from pathlib import Path


HELPER = """\
const nemoclawChatSendQueues = globalThis.__nemoclawChatSendQueues ??= new Map();
function nemoclawQueueChatSend(sessionKey, runId, work) {
\tconst queueKey = typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : runId;
\tconst previous = nemoclawChatSendQueues.get(queueKey) ?? Promise.resolve();
\tconst next = previous.catch(() => {}).then(work).finally(() => {
\t\tif (nemoclawChatSendQueues.get(queueKey) === next) nemoclawChatSendQueues.delete(queueKey);
\t});
\tnemoclawChatSendQueues.set(queueKey, next);
\treturn next;
}
function nemoclawDedupeChatHistoryMessages(messages) {
\tconst seen = new Set();
\tconst deduped = [];
\tfor (const message of messages) {
\t\tconst role = message && typeof message === "object" ? message.role : void 0;
\t\tconst timestamp = message && typeof message === "object" ? message.timestamp : void 0;
\t\tconst text = extractChatHistoryBlockText(message);
\t\tif ((role === "user" || role === "assistant") && (typeof timestamp === "number" || typeof timestamp === "string") && typeof text === "string" && text.trim()) {
\t\t\tconst key = `${role}\\0${timestamp}\\0${text.trim()}`;
\t\t\tif (seen.has(key)) continue;
\t\t\tseen.add(key);
\t\t}
\t\tdeduped.push(message);
\t}
\treturn deduped;
}
"""


def _replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def _patch_chat_bundle(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if "nemoclawQueueChatSend" in text:
        return True
    if '"chat.send": async ({ params, respond, context, client }) => {' not in text:
        return False
    if "dispatchInboundMessage({" not in text:
        return False

    text = _replace_once(
        text,
        "const chatHandlers = {",
        f"{HELPER}const chatHandlers = {{",
        f"{path}: helper insertion",
    )
    text = _replace_once(
        text,
        "\t\tconst normalized = augmentChatHistoryWithCanvasBlocks(sanitizeChatHistoryMessages(stripEnvelopeFromMessages(rawMessages.length > max ? rawMessages.slice(-max) : rawMessages), effectiveMaxChars));",
        "\t\tconst normalized = nemoclawDedupeChatHistoryMessages(augmentChatHistoryWithCanvasBlocks(sanitizeChatHistoryMessages(stripEnvelopeFromMessages(rawMessages.length > max ? rawMessages.slice(-max) : rawMessages), effectiveMaxChars)));",
        f"{path}: chat.history duplicate display turn filter",
    )
    text = _replace_once(
        text,
        "\t\t\tconst deliveredReplies = [];\n"
        "\t\t\tlet appendedWebchatAgentMedia = false;\n"
        "\t\t\tlet userTranscriptUpdatePromise = null;",
        "\t\t\tconst deliveredReplies = [];\n"
        "\t\t\tlet appendedWebchatAgentMedia = false;\n"
        "\t\t\tlet agentRunStarted = false;\n"
        "\t\t\tlet userTranscriptUpdatePromise = null;",
        f"{path}: agentRunStarted hoist",
    )
    text = _replace_once(
        text,
        "\t\t\temitUserTranscriptUpdate().catch((transcriptErr) => {\n"
        "\t\t\t\tcontext.logGateway.warn(`webchat eager user transcript update failed: ${formatForLog(transcriptErr)}`);\n"
        "\t\t\t});\n"
        "\t\t\tlet agentRunStarted = false;\n"
        "\t\t\tdispatchInboundMessage({",
        "\t\t\tnemoclawQueueChatSend(sessionKey, clientRunId, () => {\n"
        "\t\t\t\tif (trimmedMessage && !trimmedMessage.startsWith(\"/\")) agentRunStarted = true;\n"
        "\t\t\t\treturn dispatchInboundMessage({",
        f"{path}: queue dispatch opening",
    )
    text = _replace_once(
        text,
        "\t\t\t\t\tonAgentRunStart: (runId) => {\n"
        "\t\t\t\t\t\tagentRunStarted = true;\n"
        "\t\t\t\t\t\temitUserTranscriptUpdate();",
        "\t\t\t\t\tonAgentRunStart: (runId) => {\n"
        "\t\t\t\t\t\tagentRunStarted = true;",
        f"{path}: remove eager agent-start transcript append",
    )
    text = _replace_once(
        text,
        "\t\t\t\t} else emitUserTranscriptUpdate();\n"
        "\t\t\t\tsetGatewayDedupeEntry({",
        "\t\t\t\t}\n"
        "\t\t\t\tsetGatewayDedupeEntry({",
        f"{path}: remove post-agent transcript append",
    )
    text = _replace_once(
        text,
        "\t\t\t\tif (!agentRunStarted) {\n"
        "\t\t\t\t\tawait emitUserTranscriptUpdate();",
        "\t\t\t\tif (!agentRunStarted && (!trimmedMessage || trimmedMessage.startsWith(\"/\"))) {\n"
        "\t\t\t\t\tawait emitUserTranscriptUpdate();",
        f"{path}: skip fallback transcript append for normal chat text",
    )
    text = _replace_once(
        text,
        "\t\t\t}).finally(() => {\n"
        "\t\t\t\tactiveRunAbort.cleanup();\n"
        "\t\t\t\tcontext.removeChatRun(clientRunId, clientRunId, sessionKey);\n"
        "\t\t\t});\n"
        "\t\t} catch (err) {",
        "\t\t\t}).finally(() => {\n"
        "\t\t\t\tactiveRunAbort.cleanup();\n"
        "\t\t\t\tcontext.removeChatRun(clientRunId, clientRunId, sessionKey);\n"
        "\t\t\t});\n"
        "\t\t\t});\n"
        "\t\t} catch (err) {",
        f"{path}: queue dispatch closing",
    )
    path.write_text(text, encoding="utf-8")
    return True


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: patch-openclaw-chat-send-queue.py OPENCLAW_DIST", file=sys.stderr)
        return 2
    dist = Path(argv[1])
    if not dist.is_dir():
        print(f"ERROR: OpenClaw dist directory not found: {dist}", file=sys.stderr)
        return 1
    try:
        patched = [path for path in sorted(dist.glob("chat-*.js")) if _patch_chat_bundle(path)]
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if len(patched) != 1:
        print(f"ERROR: expected exactly one OpenClaw chat bundle to patch, patched {len(patched)}", file=sys.stderr)
        for path in patched:
            print(f"  patched: {path}", file=sys.stderr)
        return 1
    print(f"INFO: patched OpenClaw chat.send session queue in {patched[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
