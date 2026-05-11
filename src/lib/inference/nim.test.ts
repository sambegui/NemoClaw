// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

// Import from compiled dist/ for coverage attribution.
import * as nim from "../../../dist/lib/inference/nim";

const require = createRequire(import.meta.url);
const NIM_DIST_PATH = require.resolve("../../../dist/lib/inference/nim");
const RUNNER_PATH = require.resolve("../../../dist/lib/runner");
const fs = require("fs");

function withFirmwareModel(model: string, fn: () => void): void {
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = (p: string, ...args: unknown[]) => {
    if (p === "/sys/class/dmi/id/product_name") return model;
    if (p === "/sys/firmware/devicetree/base/model") return "";
    return origReadFileSync(p, ...args);
  };
  try {
    fn();
  } finally {
    fs.readFileSync = origReadFileSync;
  }
}

function loadNimWithMockedRunner(runCapture: Mock) {
  const runner = require(RUNNER_PATH);
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;

  delete require.cache[NIM_DIST_PATH];
  runner.run = vi.fn();
  runner.runCapture = runCapture;
  const nimModule = require(NIM_DIST_PATH);

  return {
    nimModule,
    restore() {
      delete require.cache[NIM_DIST_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
    },
  };
}

/** Check if an argv array or legacy shell command contains a specific argument. */
function hasArg(cmd: string | string[], arg: string): boolean {
  return Array.isArray(cmd) ? cmd.includes(arg) : cmd.includes(arg);
}

function hasCurlTimeoutArgs(cmd: string | string[]): boolean {
  if (!Array.isArray(cmd)) {
    return (
      cmd.includes("curl") &&
      cmd.includes("--connect-timeout 5") &&
      cmd.includes("--max-time 5")
    );
  }
  const connectTimeout = cmd.indexOf("--connect-timeout");
  const maxTime = cmd.indexOf("--max-time");
  return cmd[0] === "curl" && cmd[connectTimeout + 1] === "5" && cmd[maxTime + 1] === "5";
}

function timeoutForCommand(
  runCapture: Mock,
  predicate: (cmd: string | string[]) => boolean,
): number | undefined {
  const call = runCapture.mock.calls.find((mockCall) => {
    const cmd = mockCall[0] as string | string[];
    return predicate(cmd);
  });
  return (call?.[1] as { timeout?: number } | undefined)?.timeout;
}

describe("nim", () => {
  describe("listModels", () => {
    it("returns 5 models", () => {
      expect(nim.listModels().length).toBe(5);
    });

    it("each model has name, image, and minGpuMemoryMB", () => {
      for (const m of nim.listModels()) {
        expect(m.name).toBeTruthy();
        expect(m.image).toBeTruthy();
        expect(typeof m.minGpuMemoryMB === "number").toBeTruthy();
        expect(m.minGpuMemoryMB > 0).toBeTruthy();
      }
    });
  });

  describe("getImageForModel", () => {
    it("returns correct image for known model", () => {
      expect(nim.getImageForModel("nvidia/nemotron-3-nano-30b-a3b")).toBe(
        "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
      );
    });

    it("returns null for unknown model", () => {
      expect(nim.getImageForModel("bogus/model")).toBe(null);
    });
  });

  describe("containerName", () => {
    it("prefixes with nemoclaw-nim-", () => {
      expect(nim.containerName("my-sandbox")).toBe("nemoclaw-nim-my-sandbox");
    });
  });

  describe("detectNvidiaPlatform", () => {
    function withDmiUnavailableAndDevicetreeModel(model: string, fn: () => void): void {
      const origReadFileSync = fs.readFileSync;
      fs.readFileSync = (p: string, ...args: unknown[]) => {
        if (p === "/sys/class/dmi/id/product_name") throw new Error("ENOENT");
        if (p === "/sys/firmware/devicetree/base/model") return `${model}\0`;
        return origReadFileSync(p, ...args);
      };
      try {
        fn();
      } finally {
        fs.readFileSync = origReadFileSync;
      }
    }

    it("classifies explicit DGX Station identifiers as station", () => {
      for (const model of ["NVIDIA DGX Station GB300", "DGX-Station", "P3830"]) {
        withFirmwareModel(model, () => {
          expect(nim.detectNvidiaPlatform()).toBe("station");
        });
      }
    });

    it("does not classify unrelated Galaxy or P3830 substrings as Station", () => {
      for (const model of [
        "Samsung Galaxy Book4 Ultra",
        "Acme Galaxy Rack Server",
        "Acme XP3830 Workstation",
      ]) {
        withFirmwareModel(model, () => {
          expect(nim.detectNvidiaPlatform()).toBe("linux");
        });
      }
    });

    it("falls back to devicetree when DMI is unreadable", () => {
      withDmiUnavailableAndDevicetreeModel("NVIDIA DGX Spark", () => {
        expect(nim.detectNvidiaPlatform()).toBe("spark");
      });
    });
  });

  describe("detectGpu", () => {
    function withGenericLinuxFirmware(fn: () => void): void {
      const fs = require("fs");
      const origReadFileSync = fs.readFileSync;
      fs.readFileSync = (p: string, ...args: unknown[]) => {
        if (p === "/sys/class/dmi/id/product_name") return "Generic Linux Workstation";
        if (p === "/sys/firmware/devicetree/base/model") return "";
        return origReadFileSync(p, ...args);
      };
      try {
        fn();
      } finally {
        fs.readFileSync = origReadFileSync;
      }
    }

    it("returns object or null", () => {
      const gpu = nim.detectGpu();
      if (gpu !== null) {
        expect(gpu.type).toBeTruthy();
        expect(typeof gpu.count === "number").toBeTruthy();
        expect(typeof gpu.totalMemoryMB === "number").toBeTruthy();
        expect(typeof gpu.nimCapable === "boolean").toBeTruthy();
      }
    });

    it("nvidia type is nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "nvidia") {
        expect(gpu.nimCapable).toBe(true);
      }
    });

    it("apple type is not nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "apple") {
        expect(gpu.nimCapable).toBe(false);
        expect(gpu.name).toBeTruthy();
      }
    });

    it("populates name and memory from primary nvidia-smi path", () => {
      // Primary path returns name+memory.total in a single CSV line per GPU.
      // Regression guard for #2669: the GB300 preflight line was missing the
      // GPU model because only memory.total was being queried.
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA GB300, 284208\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA GB300",
          count: 1,
          totalMemoryMB: 284208,
          perGpuMB: 284208,
        });
      } finally {
        restore();
      }
    });

    it("aggregates totalMemoryMB across multiple GPUs from primary path", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA H100 80GB HBM3, 81920\nNVIDIA H100 80GB HBM3, 81920\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA H100 80GB HBM3",
          count: 2,
          totalMemoryMB: 163840,
          perGpuMB: 81920,
        });
      } finally {
        restore();
      }
    });

    it("preserves commas inside the GPU model name (last-comma split)", () => {
      // The CSV split must use the LAST comma, not the first, so that GPU
      // models whose names contain a comma round-trip intact. The split was
      // designed for this; the test guards against future "split on first
      // comma" regressions.
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA RTX A,B, 81920\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA RTX A,B",
          count: 1,
          totalMemoryMB: 81920,
          perGpuMB: 81920,
        });
      } finally {
        restore();
      }
    });

    it("drops name on mixed-model multi-GPU hosts so we don't attribute one model to the others", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA H100 80GB HBM3, 81920\nNVIDIA A100-SXM4-80GB, 81920\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const result = nimModule.detectGpu();
        expect(result).toMatchObject({
          type: "nvidia",
          count: 2,
          totalMemoryMB: 163840,
        });
        // Mixed-model hosts must not pin a single name; the preflight line
        // would otherwise read "2x NVIDIA H100" on a host that's actually
        // half H100 and half A100.
        expect(result?.name).toBeUndefined();
      } finally {
        restore();
      }
    });

    // Regression #2669: the previous fix added `name` only for homogeneous
    // hosts, so mixed-GPU machines (e.g. RTX PRO 6000 + GB300 on the QA
    // verification host) lost the model info entirely. We now also surface
    // the per-GPU breakdown via `gpus` so the preflight line can render it.
    it("populates the gpus breakdown on mixed-model hosts (regression #2669)", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA RTX PRO 6000 Blackwell Max-Q, 97887\nNVIDIA GB300, 256703\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const result = nimModule.detectGpu();
        expect(result?.name).toBeUndefined();
        expect(result?.gpus).toEqual([
          { name: "NVIDIA RTX PRO 6000 Blackwell Max-Q", memoryMB: 97887 },
          { name: "NVIDIA GB300", memoryMB: 256703 },
        ]);
      } finally {
        restore();
      }
    });

    it("populates the gpus breakdown on homogeneous hosts too", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA H100 80GB HBM3, 81920\nNVIDIA H100 80GB HBM3, 81920\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const result = nimModule.detectGpu();
        expect(result?.gpus).toEqual([
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
        ]);
      } finally {
        restore();
      }
    });

    it("populates the gpus breakdown on the unified-memory fallback path (#2669 GB10)", () => {
      // Spark / Jetson don't have memory.total per GPU — host RAM is split
      // evenly across the named devices. Used by the original GB10 reporter.
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd.some((a: string) => a.includes("memory.total"))) return "";
        if (cmd.some((a: string) => a.includes("query-gpu=name"))) {
          return "NVIDIA GB10\n";
        }
        if (cmd[0] === "free" && cmd[1] === "-m") {
          return "              total        used        free\nMem:         131072       10240       90000\nSwap:             0           0           0";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const result = nimModule.detectGpu();
        expect(result?.gpus).toEqual([{ name: "NVIDIA GB10", memoryMB: 131072 }]);
      } finally {
        restore();
      }
    });

    it("detects GB10 unified-memory GPUs as Spark-capable NVIDIA devices", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd.some((a: string) => a.includes("memory.total"))) return "";
        if (cmd.some((a: string) => a.includes("query-gpu=name"))) return "NVIDIA GB10";
        if (cmd[0] === "free" && cmd[1] === "-m") return "              total        used        free      shared  buff/cache   available\nMem:         131072       10240       90000        1024       30832      119808\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA GB10",
          count: 1,
          totalMemoryMB: 131072,
          perGpuMB: 131072,
          nimCapable: true,
          unifiedMemory: true,
          spark: true,
        });
      } finally {
        restore();
      }
    });

    it("detects Orin unified-memory GPUs without marking them as Spark", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd.some((a: string) => a.includes("memory.total"))) return "";
        if (cmd.some((a: string) => a.includes("query-gpu=name"))) return "NVIDIA Jetson AGX Orin";
        if (cmd[0] === "free" && cmd[1] === "-m") return "              total        used        free      shared  buff/cache   available\nMem:          32768        5120       20000         512       7148       27136\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        withGenericLinuxFirmware(() => {
          expect(nimModule.detectGpu()).toMatchObject({
            type: "nvidia",
            name: "NVIDIA Jetson AGX Orin",
            count: 1,
            totalMemoryMB: 32768,
            perGpuMB: 32768,
            nimCapable: true,
            unifiedMemory: true,
            spark: false,
          });
        });
      } finally {
        restore();
      }
    });

    it("marks low-memory unified-memory NVIDIA devices as not NIM-capable", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd.some((a: string) => a.includes("memory.total"))) return "";
        if (cmd.some((a: string) => a.includes("query-gpu=name"))) return "NVIDIA Xavier";
        if (cmd[0] === "free" && cmd[1] === "-m") return "              total        used        free      shared  buff/cache   available\nMem:           4096        1024        2048         256       1024        2816\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        withGenericLinuxFirmware(() => {
          expect(nimModule.detectGpu()).toMatchObject({
            type: "nvidia",
            name: "NVIDIA Xavier",
            totalMemoryMB: 4096,
            nimCapable: false,
            unifiedMemory: true,
            spark: false,
          });
        });
      } finally {
        restore();
      }
    });
  });

  describe("groupGpusByName", () => {
    it("groups identical names and sums their memory", () => {
      expect(
        nim.groupGpusByName([
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
        ]),
      ).toEqual([{ name: "NVIDIA H100 80GB HBM3", count: 2, memoryMB: 163840 }]);
    });

    it("preserves first-appearance order across distinct names", () => {
      expect(
        nim.groupGpusByName([
          { name: "NVIDIA RTX PRO 6000 Blackwell Max-Q", memoryMB: 97887 },
          { name: "NVIDIA GB300", memoryMB: 256703 },
        ]).map((g: { name: string }) => g.name),
      ).toEqual(["NVIDIA RTX PRO 6000 Blackwell Max-Q", "NVIDIA GB300"]);
    });

    it("groups duplicates and singletons together (2x H100 + 1x A100)", () => {
      expect(
        nim.groupGpusByName([
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA A100 40GB", memoryMB: 40960 },
        ]),
      ).toEqual([
        { name: "NVIDIA H100 80GB HBM3", count: 2, memoryMB: 163840 },
        { name: "NVIDIA A100 40GB", count: 1, memoryMB: 40960 },
      ]);
    });

    it("normalizes internal whitespace before comparing names", () => {
      // Defensive: nvidia-smi shouldn't return double spaces, but if a driver
      // ever does, we shouldn't split what is logically the same model.
      expect(
        nim.groupGpusByName([
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA  H100  80GB HBM3", memoryMB: 81920 },
        ]),
      ).toEqual([{ name: "NVIDIA H100 80GB HBM3", count: 2, memoryMB: 163840 }]);
    });

    it("drops rows with blank names", () => {
      expect(
        nim.groupGpusByName([
          { name: "", memoryMB: 81920 },
          { name: "  ", memoryMB: 81920 },
          { name: "NVIDIA GB300", memoryMB: 256703 },
        ]),
      ).toEqual([{ name: "NVIDIA GB300", count: 1, memoryMB: 256703 }]);
    });
  });

  describe("formatNvidiaGpuPreflightLines", () => {
    it("renders single GPU as a compact one-liner", () => {
      const lines = nim.formatNvidiaGpuPreflightLines({
        type: "nvidia",
        name: "NVIDIA GB300",
        gpus: [{ name: "NVIDIA GB300", memoryMB: 284208 }],
        count: 1,
        totalMemoryMB: 284208,
        perGpuMB: 284208,
        nimCapable: true,
      });
      expect(lines).toEqual(["NVIDIA GPU detected (NVIDIA GB300, 284208 MB)"]);
    });

    it("renders N homogeneous GPUs as `Nx <model>` in the compact form", () => {
      const lines = nim.formatNvidiaGpuPreflightLines({
        type: "nvidia",
        name: "NVIDIA H100 80GB HBM3",
        gpus: [
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
        ],
        count: 2,
        totalMemoryMB: 163840,
        perGpuMB: 81920,
        nimCapable: true,
      });
      expect(lines).toEqual([
        "NVIDIA GPU detected (2x NVIDIA H100 80GB HBM3, 163840 MB)",
      ]);
    });

    // Regression #2669: this is the case the previous fix missed entirely.
    it("renders mixed-model 1+1 with breakdown and no `Nx ` prefix", () => {
      const lines = nim.formatNvidiaGpuPreflightLines({
        type: "nvidia",
        gpus: [
          { name: "NVIDIA RTX PRO 6000 Blackwell Max-Q", memoryMB: 97887 },
          { name: "NVIDIA GB300", memoryMB: 256703 },
        ],
        count: 2,
        totalMemoryMB: 354590,
        perGpuMB: 97887,
        nimCapable: true,
      });
      expect(lines).toEqual([
        "NVIDIA GPU detected: 2 GPUs, 354590 MB VRAM",
        "    - NVIDIA RTX PRO 6000 Blackwell Max-Q (97887 MB)",
        "    - NVIDIA GB300 (256703 MB)",
      ]);
    });

    it("renders mixed-model with duplicates using `Nx ` prefix across all groups", () => {
      const lines = nim.formatNvidiaGpuPreflightLines({
        type: "nvidia",
        gpus: [
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA H100 80GB HBM3", memoryMB: 81920 },
          { name: "NVIDIA A100 40GB", memoryMB: 40960 },
        ],
        count: 3,
        totalMemoryMB: 204800,
        perGpuMB: 81920,
        nimCapable: true,
      });
      expect(lines).toEqual([
        "NVIDIA GPU detected: 3 GPUs, 204800 MB VRAM",
        "    - 2x NVIDIA H100 80GB HBM3 (163840 MB)",
        "    - 1x NVIDIA A100 40GB (40960 MB)",
      ]);
    });

    it("falls back to count-only when every parsed row had a blank name", () => {
      const lines = nim.formatNvidiaGpuPreflightLines({
        type: "nvidia",
        gpus: [
          { name: "", memoryMB: 81920 },
          { name: "", memoryMB: 81920 },
        ],
        count: 2,
        totalMemoryMB: 163840,
        perGpuMB: 81920,
        nimCapable: true,
      });
      expect(lines).toEqual(["NVIDIA GPU detected: 2 GPU(s), 163840 MB VRAM"]);
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      expect(st.running).toBe(false);
    });
  });

  describe("waitForNimHealth", () => {
    it("bounds curl health probes with connect and total timeouts", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:9000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.waitForNimHealth(9000, 1)).toBe(true);
        const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => c);

        expect(commands.some((c) => c[0] === "curl" && hasCurlTimeoutArgs(c))).toBe(true);
      } finally {
        restore();
      }
    });
  });

  describe("nimStatusByName", () => {
    it("uses provided port directly", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "docker" && cmd.includes("inspect")) return "running";
        if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:9000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo", 9000);
        const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => c);

        expect(st).toMatchObject({
          running: true,
          healthy: true,
          container: "foo",
          state: "running",
        });
        expect(commands.some((c) => c[0] === "docker" && c.includes("port"))).toBe(false);
        expect(commands.some((c) => c.includes("http://127.0.0.1:9000/v1/models"))).toBe(
          true,
        );
        expect(commands.some((c) => c[0] === "curl" && hasCurlTimeoutArgs(c))).toBe(true);
        expect(
          timeoutForCommand(
            runCapture,
            (c) => Array.isArray(c) && c[0] === "docker" && c.includes("inspect"),
          ),
        ).toBe(5000);
        expect(
          timeoutForCommand(
            runCapture,
            (c) => Array.isArray(c) && c[0] === "curl" && c.includes("http://127.0.0.1:9000/v1/models"),
          ),
        ).toBe(6000);
      } finally {
        restore();
      }
    });

    it("uses published docker port when no port is provided", () => {
      for (const mapping of ["0.0.0.0:9000", "127.0.0.1:9000", "[::]:9000", ":::9000"]) {
        const runCapture = vi.fn((cmd: string | string[]) => {
          if (!Array.isArray(cmd)) throw new Error("expected argv array");
          if (cmd[0] === "docker" && cmd.includes("inspect")) return "running";
          if (cmd[0] === "docker" && cmd.includes("port")) return mapping;
          if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:9000/v1/models")) return '{"data":[]}';
          return "";
        });
        const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

        try {
          const st = nimModule.nimStatusByName("foo");
          const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => c);

          expect(st).toMatchObject({ running: true, healthy: true, container: "foo", state: "running" });
          expect(commands.some((c) => c[0] === "docker" && c.includes("port"))).toBe(true);
          expect(commands.some((c) => c.includes("http://127.0.0.1:9000/v1/models"))).toBe(
            true,
          );
          expect(
            timeoutForCommand(
              runCapture,
              (c) => Array.isArray(c) && c[0] === "docker" && c.includes("inspect"),
            ),
          ).toBe(5000);
          expect(
            timeoutForCommand(
              runCapture,
              (c) => Array.isArray(c) && c[0] === "docker" && c.includes("port"),
            ),
          ).toBe(5000);
        } finally {
          restore();
        }
      }
    });

    it("falls back to 8000 when docker port lookup fails", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "docker" && cmd.includes("inspect")) return "running";
        if (cmd[0] === "docker" && cmd.includes("port")) return "";
        if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:8000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => c);

        expect(st).toMatchObject({ running: true, healthy: true, container: "foo", state: "running" });
        expect(commands.some((c) => c[0] === "docker" && c.includes("port"))).toBe(true);
        expect(commands.some((c) => c.includes("http://127.0.0.1:8000/v1/models"))).toBe(
          true,
        );
      } finally {
        restore();
      }
    });

    it("does not run health check when container is not running", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "docker" && cmd.includes("inspect")) return "exited";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        expect(st).toMatchObject({ running: false, healthy: false, container: "foo", state: "exited" });
        expect(
          timeoutForCommand(
            runCapture,
            (c) => Array.isArray(c) && c[0] === "docker" && c.includes("inspect"),
          ),
        ).toBe(5000);
        expect(runCapture.mock.calls).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });

  describe("shouldShowNimLine", () => {
    it("hides the line for cloud-only sandboxes (no container, nothing running)", () => {
      expect(nim.shouldShowNimLine(null, false)).toBe(false);
      expect(nim.shouldShowNimLine(undefined, false)).toBe(false);
      expect(nim.shouldShowNimLine("", false)).toBe(false);
    });

    it("shows the line when the sandbox is bound to a NIM container", () => {
      expect(nim.shouldShowNimLine("nim-foo", false)).toBe(true);
      expect(nim.shouldShowNimLine("nim-foo", true)).toBe(true);
    });

    it("still surfaces an orphan NIM container even when none is registered", () => {
      expect(nim.shouldShowNimLine(null, true)).toBe(true);
      expect(nim.shouldShowNimLine(undefined, true)).toBe(true);
    });
  });

  describe("isNgcLoggedIn", () => {
    const fs = require("fs");
    const os = require("os");

    function mockDockerConfig(config: string | null) {
      const origReadFileSync = fs.readFileSync;
      const origHomedir = os.homedir;
      os.homedir = () => "/mock-home";
      if (config === null) {
        fs.readFileSync = () => { throw new Error("ENOENT"); };
      } else {
        fs.readFileSync = (p: string, ...args: unknown[]) => {
          if (typeof p === "string" && p.includes(".docker/config.json")) return config;
          return origReadFileSync(p, ...args);
        };
      }
      return () => {
        fs.readFileSync = origReadFileSync;
        os.homedir = origHomedir;
      };
    }

    it("returns true when credHelpers has nvcr.io", () => {
      const restore = mockDockerConfig(JSON.stringify({ credHelpers: { "nvcr.io": "secretservice" } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns true when auths has nvcr.io with auth field", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: { "nvcr.io": { auth: "dXNlcjpwYXNz" } } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns true when auths has https://nvcr.io with auth field", () => {
      const restore = mockDockerConfig(
        JSON.stringify({ auths: { "https://nvcr.io": { auth: "dXNlcjpwYXNz" } } }),
      );
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns false when auths has nvcr.io but empty entry", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: { "nvcr.io": {} } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when config file is missing", () => {
      const restore = mockDockerConfig(null);
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when config has malformed JSON", () => {
      const restore = mockDockerConfig("not json");
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when auths is empty and no credHelpers", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: {} }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns true when empty nvcr.io marker exists and credsStore is set (Docker Desktop)", () => {
      const restore = mockDockerConfig(
        JSON.stringify({ credsStore: "desktop", auths: { "nvcr.io": {} } }),
      );
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns false when credsStore is set but no nvcr.io marker (not logged in)", () => {
      const restore = mockDockerConfig(
        JSON.stringify({ credsStore: "desktop", auths: {} }),
      );
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when empty nvcr.io marker exists but no credsStore", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: { "nvcr.io": {} } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });
  });
});
