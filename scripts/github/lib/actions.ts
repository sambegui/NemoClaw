// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared helpers for small GitHub Actions TypeScript entrypoints. */

import { appendFileSync } from "node:fs";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function parseCsv(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function selectCsvJobs(
  requestedJobs: string,
  outputsToJobIds: ReadonlyMap<string, string>,
): Map<string, boolean> {
  const requested = parseCsv(requestedJobs);
  const selectAll = requested.size === 0;
  return new Map(
    [...outputsToJobIds].map(([outputName, jobId]) => [
      outputName,
      selectAll || requested.has(jobId),
    ]),
  );
}

function appendLineFromEnv(envName: string, line: string): void {
  const filePath = process.env[envName];
  if (!filePath) {
    console.log(`${envName} not set; ${line}`);
    return;
  }
  appendFileSync(filePath, `${line}\n`, { encoding: "utf-8" });
}

export function setOutput(name: string, value: string | boolean | number): void {
  const rendered = String(value);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log(`${name}=${rendered}`);
    return;
  }
  if (rendered.includes("\n")) {
    const delimiter = `EOF_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    appendFileSync(outputFile, `${name}<<${delimiter}\n${rendered}\n${delimiter}\n`, {
      encoding: "utf-8",
    });
    return;
  }
  appendFileSync(outputFile, `${name}=${rendered}\n`, { encoding: "utf-8" });
}

export function exportEnv(name: string, value: string): void {
  appendLineFromEnv("GITHUB_ENV", `${name}=${value}`);
}

export function appendStepSummary(markdown: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    console.log(markdown);
    return;
  }
  appendFileSync(summaryFile, markdown, { encoding: "utf-8" });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
