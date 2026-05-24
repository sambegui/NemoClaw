// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { exportEnv, shellQuote, selectCsvJobs } from "../scripts/github/lib/actions.ts";
import { runChecked } from "../scripts/github/lib/exec.ts";
import { shellcheckJsonToSarif } from "../scripts/github/lib/shellcheck-sarif.ts";
import { extractPreviewUrl, flattenPaginatedComments } from "../scripts/github/fern-preview.ts";
import { parseOutputMappings } from "../scripts/github/select-jobs.ts";
import {
  buildFullE2EScript,
  buildRunScenarioScript,
  npmInstallCommandForMode,
  windowsPathToWsl,
  withWslEnv,
} from "../scripts/github/wsl.ts";

const ORIGINAL_WSLENV = process.env.WSLENV;
let envFileToRemove: string | undefined;

afterEach(() => {
  delete process.env.GITHUB_ENV;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.GITHUB_TOKEN;
  if (ORIGINAL_WSLENV === undefined) {
    delete process.env.WSLENV;
  } else {
    process.env.WSLENV = ORIGINAL_WSLENV;
  }
  if (envFileToRemove) {
    rmSync(path.dirname(envFileToRemove), { force: true, recursive: true });
    envFileToRemove = undefined;
  }
});

describe("GitHub workflow utility helpers", () => {
  it("converts Windows checkout paths to WSL mount paths", () => {
    expect(windowsPathToWsl("D:\\a\\NemoClaw\\NemoClaw")).toBe("/mnt/d/a/NemoClaw/NemoClaw");
    expect(windowsPathToWsl("C:/Users/runneradmin/work/repo")).toBe(
      "/mnt/c/Users/runneradmin/work/repo",
    );
  });

  it("quotes single quotes for generated bash snippets", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("can't leak")).toBe("'can'\"'\"'t leak'");
  });

  it("selects all jobs for empty dispatch input and exact matches otherwise", () => {
    const mapping = parseOutputMappings([
      "dashboard=dashboard-remote-bind-e2e",
      "gateway=gateway-health-honest-e2e",
    ]);
    expect(Object.fromEntries(selectCsvJobs("", mapping))).toEqual({
      dashboard: true,
      gateway: true,
    });
    expect(Object.fromEntries(selectCsvJobs(" gateway-health-honest-e2e ", mapping))).toEqual({
      dashboard: false,
      gateway: true,
    });
  });

  it("converts shellcheck json1 comments to SARIF", () => {
    const sarif = shellcheckJsonToSarif({
      comments: [
        {
          file: "scripts/example.sh",
          line: 3,
          endLine: 3,
          column: 7,
          endColumn: 12,
          level: "warning",
          code: 2086,
          message: "Double quote to prevent globbing and word splitting.",
        },
      ],
    });

    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.rules[0].id).toBe("SC2086");
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "SC2086",
      level: "warning",
      message: { text: "Double quote to prevent globbing and word splitting." },
    });
  });

  it("extracts Fern preview URLs from CLI output", () => {
    expect(extractPreviewUrl("Published docs to https://preview.example.test/foo\n")).toBe(
      "https://preview.example.test/foo",
    );
    expect(extractPreviewUrl("no url here")).toBeUndefined();
  });

  it("flattens paginated GitHub comment responses", () => {
    expect(
      flattenPaginatedComments([
        [{ id: 1, body: "first page" }],
        [{ id: 2, body: "second page" }],
      ]),
    ).toEqual([
      { id: 1, body: "first page" },
      { id: 2, body: "second page" },
    ]);
  });

  it("writes multiline GitHub environment values using delimiter syntax", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gh-env-"));
    envFileToRemove = path.join(dir, "env");
    process.env.GITHUB_ENV = envFileToRemove;

    exportEnv("MULTILINE", "one\ntwo");
    const written = readFileSync(envFileToRemove, "utf-8");

    expect(written).toMatch(/^MULTILINE<<EOF_MULTILINE_/);
    expect(written).toContain("\none\ntwo\n");
  });

  it("allowlists WSL npm install modes", () => {
    expect(npmInstallCommandForMode("ci")).toBe("npm ci --ignore-scripts");
    expect(npmInstallCommandForMode("install")).toBe("npm install --ignore-scripts");
    expect(() => npmInstallCommandForMode("npm install && curl example.test")).toThrow(
      /Unsupported WSL_NPM_INSTALL_MODE/,
    );
  });

  it("runs the select-jobs entrypoint and writes GitHub outputs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gh-output-"));
    envFileToRemove = path.join(dir, "output");
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "scripts/github/select-jobs.ts",
        "dashboard=dashboard-remote-bind-e2e",
        "gateway=gateway-health-honest-e2e",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: envFileToRemove,
          JOBS: "gateway-health-honest-e2e",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(envFileToRemove, "utf-8")).toBe("dashboard=false\ngateway=true\n");
  });

  it("keeps secret values out of generated WSL scripts", () => {
    process.env.NVIDIA_API_KEY = "nvapi-secret-test-value";
    process.env.GITHUB_TOKEN = "ghs-secret-test-value";

    const fullE2E = buildFullE2EScript("/tmp/workdir");
    const scenario = buildRunScenarioScript("/tmp/workdir", "wsl-repo-cloud-openclaw");

    expect(fullE2E).not.toContain("nvapi-secret-test-value");
    expect(fullE2E).not.toContain("ghs-secret-test-value");
    expect(fullE2E).toContain("${NVIDIA_API_KEY:-}");
    expect(scenario).not.toContain("nvapi-secret-test-value");
    expect(scenario).toContain("${NVIDIA_API_KEY:-}");
  });

  it("adds WSLENV entries only for the duration of a WSL invocation", () => {
    process.env.WSLENV = "PATH/p";
    let observed = "";

    const returned = withWslEnv(["NVIDIA_API_KEY", "GITHUB_TOKEN"], () => {
      observed = process.env.WSLENV ?? "";
      return 42;
    });

    expect(returned).toBe(42);
    expect(observed.split(":")).toEqual(["PATH/p", "NVIDIA_API_KEY", "GITHUB_TOKEN"]);
    expect(process.env.WSLENV).toBe("PATH/p");
  });

  it("includes stderr in checked command failures", () => {
    expect(() =>
      runChecked(process.execPath, ["-e", "console.error('boom'); process.exit(7)"]),
    ).toThrow(/exit code: 7[\s\S]*stderr:\nboom/);
  });
});
