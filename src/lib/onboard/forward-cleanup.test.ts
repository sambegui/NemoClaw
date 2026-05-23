// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  bestEffortForwardStop,
  bestEffortForwardStopForSandbox,
} from "../../../dist/lib/onboard/forward-cleanup";

function forwardListWith(entries: Array<{ sandbox: string; port: number; status?: string }>): string {
  const header = "SANDBOX   BIND        PORT   PID    STATUS";
  const rows = entries.map(
    (e) => `${e.sandbox}  127.0.0.1   ${e.port}   1234   ${e.status ?? "running"}`,
  );
  return [header, ...rows].join("\n");
}

describe("bestEffortForwardStop", () => {
  it("invokes `forward stop` with the port and silently ignores errors", () => {
    const run = vi.fn();
    bestEffortForwardStop(run, 18789);
    expect(run).toHaveBeenCalledWith(
      ["forward", "stop", "18789"],
      { ignoreError: true, suppressOutput: true },
    );
  });
});

describe("bestEffortForwardStopForSandbox", () => {
  it("returns owned-other and skips stop when the port belongs to a different sandbox", () => {
    const run = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "other-sandbox", port: 18789 }]));

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("owned-other");
    expect(run).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ ignoreError: true, timeout: 5_000 }),
    );
  });

  it("returns stopped and runs forward stop when the port belongs to the same sandbox", () => {
    const run = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("stopped");
    expect(run).toHaveBeenCalledWith(
      ["forward", "stop", "18789"],
      { ignoreError: true, suppressOutput: true },
    );
  });

  it("returns no-entry and runs stop defensively when no live forward is on that port", () => {
    const run = vi.fn();
    const fetch = vi.fn().mockReturnValue(forwardListWith([]));

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("no-entry");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls through to a defensive stop when `forward list` itself throws", () => {
    const run = vi.fn();
    const fetch = vi.fn().mockImplementation(() => {
      throw new Error("gateway timed out");
    });

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("list-failed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores forwards with non-live status when deciding ownership", () => {
    // `getOccupiedPorts` filters by `isLiveForwardStatus`, so a "stopped"
    // entry on the requested port should be treated as no-entry (not as a
    // foreign owner).
    const run = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValue(
        forwardListWith([{ sandbox: "other-sandbox", port: 18789, status: "stopped" }]),
      );

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("no-entry");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
