// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectOpenShellStateRpcResultIssue } from "./adapters/openshell/gateway-drift";
import { captureOpenshell } from "./adapters/openshell/runtime";
import { recoverNamedGatewayRuntime } from "./gateway-runtime-action";

type SandboxListResult = ReturnType<typeof captureOpenshell>;

export type SandboxListRecoveryResult = {
  result: SandboxListResult;
  recoveryAttempted: boolean;
  recoverySucceeded: boolean;
};

export async function captureSandboxListWithGatewayRecovery(): Promise<SandboxListRecoveryResult> {
  const initial = captureOpenshell(["sandbox", "list"]);
  if (initial.status === 0 || detectOpenShellStateRpcResultIssue(initial)) {
    return { result: initial, recoveryAttempted: false, recoverySucceeded: false };
  }

  const recovery = await recoverNamedGatewayRuntime();
  if (!recovery.recovered) {
    return { result: initial, recoveryAttempted: true, recoverySucceeded: false };
  }

  return {
    result: captureOpenshell(["sandbox", "list"]),
    recoveryAttempted: true,
    recoverySucceeded: true,
  };
}

export function printSandboxListFailureWithRecoveryContext(
  recoveryResult: SandboxListRecoveryResult,
): void {
  console.error("  Failed to query running sandboxes from OpenShell.");
  if (recoveryResult.recoveryAttempted) {
    if (recoveryResult.recoverySucceeded) {
      console.error("  The NemoClaw OpenShell gateway was recovered, but the sandbox query still failed.");
    } else {
      console.error("  NemoClaw tried to recover its OpenShell gateway, but recovery did not complete.");
    }
  }
  console.error("  Ensure OpenShell is running: openshell status");
}
