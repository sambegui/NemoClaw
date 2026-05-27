#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function findFakeOpenshell() {
  const homeEntries = process.env.HOME
    ? [path.join(process.env.HOME, "bin"), path.join(process.env.HOME, ".local", "bin")]
    : [];
  const pathEntries = [
    ...homeEntries,
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of pathEntries) {
    const candidate = path.join(dir, "openshell");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const host = process.argv[2] || "";
const remoteCommand = process.argv.slice(3).join(" ");
const match = /^openshell-(.+)$/.exec(host);

if (!match || !remoteCommand) {
  process.stderr.write("usage: grpc-fake-ssh openshell-<sandbox> <command>\n");
  process.exit(64);
}

const openshell = findFakeOpenshell();
const home = process.env.HOME ? path.resolve(process.env.HOME) : "";
if (!openshell || !home || !path.resolve(openshell).startsWith(`${home}${path.sep}`)) {
  process.stderr.write("grpc fake transport could not find the hermetic fake openshell under HOME\n");
  process.exit(127);
}

const result = spawnSync(
  openshell,
  ["sandbox", "exec", "--name", match[1], "--", "sh", "-c", remoteCommand],
  {
    input: fs.readFileSync(0),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  },
);

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

if (result.stdout && result.stdout.length > 0) {
  fs.writeSync(1, result.stdout);
}
if (result.stderr && result.stderr.length > 0) {
  fs.writeSync(2, result.stderr);
}
process.exit(result.status ?? 1);
