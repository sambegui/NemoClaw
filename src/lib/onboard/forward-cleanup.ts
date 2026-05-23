// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getOccupiedPorts } from "./dashboard-port";

export type ForwardStopRunner = (
  args: string[],
  opts: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

export type ForwardListRunner = (
  args: string[],
  opts: { ignoreError?: boolean; timeout?: number },
) => string;

export function bestEffortForwardStop(
  runOpenshell: ForwardStopRunner,
  port: string | number,
): void {
  runOpenshell(["forward", "stop", String(port)], {
    ignoreError: true,
    suppressOutput: true,
  });
}

/**
 * Stop the forward on `port` only when `openshell forward list` reports it
 * is owned by `sandboxName` (or unowned). Prevents the dashboard-forward
 * recovery / retry path from killing another sandbox's forward when two
 * onboard runs race on the same port.
 *
 * Returns:
 *   - "stopped"       — entry matched sandboxName and the stop ran.
 *   - "owned-other"   — entry exists for a different sandbox; stop skipped.
 *   - "no-entry"      — no live entry for that port; stop ran defensively.
 *   - "list-failed"   — could not enumerate forwards; stop ran defensively.
 */
export function bestEffortForwardStopForSandbox(
  runOpenshell: ForwardStopRunner,
  runCaptureOpenshell: ForwardListRunner,
  port: string | number,
  sandboxName: string,
): "stopped" | "owned-other" | "no-entry" | "list-failed" {
  let listOutput = "";
  try {
    listOutput = runCaptureOpenshell(["forward", "list"], {
      ignoreError: true,
      timeout: 5_000,
    });
  } catch {
    bestEffortForwardStop(runOpenshell, port);
    return "list-failed";
  }
  const owner = getOccupiedPorts(listOutput).get(String(port)) ?? null;
  if (owner && owner !== sandboxName) {
    return "owned-other";
  }
  bestEffortForwardStop(runOpenshell, port);
  return owner === sandboxName ? "stopped" : "no-entry";
}
