#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const http = require("http");

const host = process.env.FAKE_SLACK_API_HOST || "0.0.0.0";
const port = Number(process.env.FAKE_SLACK_API_PORT || "0");
const portFile = process.env.FAKE_SLACK_API_PORT_FILE || "";
const captureFile = process.env.FAKE_SLACK_API_CAPTURE_FILE || "";
const expectedBotToken = process.env.FAKE_SLACK_API_EXPECTED_BOT_TOKEN || "";
const expectedAppToken = process.env.FAKE_SLACK_API_EXPECTED_APP_TOKEN || "";

if (!expectedBotToken || !expectedAppToken) {
  console.error("FAKE_SLACK_API_EXPECTED_BOT_TOKEN and FAKE_SLACK_API_EXPECTED_APP_TOKEN are required");
  process.exit(2);
}

function record(event) {
  if (!captureFile) return;
  fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

function expectedTokenForPath(pathname) {
  if (pathname === "/api/apps.connections.open") return expectedAppToken;
  return expectedBotToken;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const pathname = new URL(req.url || "/", "http://fake-slack.local").pathname;
    const authorization = req.headers.authorization || "";
    const expectedToken = expectedTokenForPath(pathname);
    const expectedAuthorization = `Bearer ${expectedToken}`;
    const tokenMatchesExpected = authorization === expectedAuthorization;

    record({
      event: "request",
      method: req.method,
      path: pathname,
      authorization,
      body,
      tokenMatchesExpected,
      tokenLooksPlaceholder:
        typeof authorization === "string" &&
        (authorization.includes("openshell:resolve:env:") ||
          authorization.includes("OPENSHELL-RESOLVE-ENV-") ||
          body.includes("openshell:resolve:env:") ||
          body.includes("OPENSHELL-RESOLVE-ENV-")),
    });

    res.writeHead(tokenMatchesExpected ? 200 : 401, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        ok: false,
        error: tokenMatchesExpected ? "invalid_auth" : "bad_auth",
        endpoint: pathname,
      }),
    );
  });
});

server.listen(port, host, () => {
  const address = server.address();
  if (portFile) {
    fs.writeFileSync(portFile, `${address.port}\n`, { mode: 0o600 });
  }
  record({ event: "listening", host, port: address.port });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
