// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared CSV job selector for manually dispatched workflow fan-out gates. */

import { optionalEnv, selectCsvJobs, setOutput } from "./lib/actions.ts";
import { isMainModule } from "./lib/module.ts";

export function parseOutputMappings(args: readonly string[]): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator <= 0 || separator === arg.length - 1) {
      throw new Error(`Expected mapping in output_name=job-id form, got: ${arg}`);
    }
    mappings.set(arg.slice(0, separator), arg.slice(separator + 1));
  }
  if (mappings.size === 0) {
    throw new Error("At least one output_name=job-id mapping is required.");
  }
  return mappings;
}

function main(): void {
  const selections = selectCsvJobs(optionalEnv("JOBS"), parseOutputMappings(process.argv.slice(2)));
  for (const [outputName, selected] of selections) {
    setOutput(outputName, selected);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
