// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "./shell-probe.ts";

// User-facing phase a negative scenario advertises. Mirrors the typed
// runner's ExpectedFailurePhase (scenarios/types.ts) so a scenario expressed
// in Vitest declares its failure mode with the same vocabulary.
export type ExpectFailurePhase = "environment" | "onboarding" | "preflight" | "runtime";

export interface ExpectFailureContract {
  // The phase the failure is expected to surface in. Recorded for diagnostics
  // and for the caller to route follow-up absence checks; the result-level
  // helper cannot itself attribute a subprocess failure to a phase, so this is
  // declarative intent rather than something the helper re-derives.
  phase: ExpectFailurePhase;
  // The failure mode the command must advertise, by class name
  // (e.g. "docker-missing", "gateway-port-conflict").
  errorClass: string;
  // Side effects that must NOT have occurred (e.g. "gateway-started",
  // "sandbox-created"). The helper echoes these back; verifying their absence
  // is the job of `gateway.expectAbsent()` / `sandbox.expectAbsent()`.
  forbiddenSideEffects?: readonly string[];
}

export interface ExpectFailureOutcome {
  phase: ExpectFailurePhase;
  errorClass: string;
  forbiddenSideEffects: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

// Substring-with-case-fold match where dashes/underscores/spaces are
// interchangeable. Kept identical to the typed runner's negative matcher so a
// failure that satisfies the bash/TS runner also satisfies the Vitest helper.
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "-");
}

function errorClassMatches(output: string, errorClass: string): boolean {
  return normalize(output).includes(normalize(errorClass));
}

/**
 * Assert that a captured subprocess result honors a negative-scenario
 * contract: it must have failed (non-zero exit or a terminating signal) and
 * must advertise the declared `errorClass` somewhere in its output.
 *
 * This is a pure, result-level check — it performs no I/O. Verifying that the
 * `forbiddenSideEffects` did not occur is delegated to the absence checks on
 * the gateway/sandbox clients; this helper returns the declared set so a test
 * can drive those follow-ups.
 */
export function expectFailure(result: ShellProbeResult, contract: ExpectFailureContract): ExpectFailureOutcome {
  const errorClass = contract.errorClass.trim();
  if (!errorClass) {
    throw new Error("expectFailure requires a non-empty errorClass");
  }

  const failed = result.exitCode !== 0 || result.signal !== null;
  if (!failed) {
    throw new Error(
      `expectFailure(${contract.phase}/${errorClass}): expected the command to fail, but it exited 0`,
    );
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (!errorClassMatches(output, errorClass)) {
    const detail = (result.stderr.trim() || result.stdout.trim() || "<no output>").slice(0, 240);
    throw new Error(
      `expectFailure(${contract.phase}/${errorClass}): command failed but did not advertise errorClass "${errorClass}"; observed="${detail}"`,
    );
  }

  return {
    phase: contract.phase,
    errorClass,
    forbiddenSideEffects: contract.forbiddenSideEffects ?? [],
    exitCode: result.exitCode,
    signal: result.signal,
  };
}
