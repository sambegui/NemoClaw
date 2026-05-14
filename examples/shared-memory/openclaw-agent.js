#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");

const plugin = require(path.resolve(
  __dirname,
  "..",
  "..",
  "nemoclaw-blueprint",
  "openclaw-plugins",
  "shared-memory",
  "index.js",
));

async function main() {
  const [action, rawArgs = "{}"] = process.argv.slice(2);
  if (!action) {
    console.error("usage: openclaw-agent.js <publish|query|subscribe|poll|ack> [json-args]");
    process.exit(2);
  }

  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    console.error(`invalid JSON args: ${error.message}`);
    process.exit(2);
  }

  const result = await plugin.sharedMemoryTool({ action, ...args });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && result.error) process.exit(1);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
