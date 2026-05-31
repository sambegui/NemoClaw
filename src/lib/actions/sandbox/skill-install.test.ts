// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionAgent = vi.hoisted(() => vi.fn());
const ensureLiveSandboxOrExit = vi.hoisted(() => vi.fn());
const skillInstall = vi.hoisted(() => ({
  validateSkillName: vi.fn(),
  resolveSkillPaths: vi.fn(),
  checkExisting: vi.fn(),
  removeSkill: vi.fn(),
  verifyRemove: vi.fn(),
  parseFrontmatter: vi.fn(),
  collectFiles: vi.fn(),
  uploadDirectory: vi.fn(),
  postInstall: vi.fn(),
  verifyInstall: vi.fn(),
}));

vi.mock("../../agent/runtime", () => ({
  getSessionAgent,
}));

vi.mock("../../skill-install", () => skillInstall);

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit,
}));

import { installSandboxSkill, removeSandboxSkill } from "./skill-install";

const paths = {
  uploadDir: "/sandbox/.openclaw/skills/demo-skill",
  mirrorDir: "$HOME/.openclaw/skills/demo-skill",
  sessionFile: "/sandbox/.openclaw/agents/main/sessions/sessions.json",
  isOpenClaw: true,
};

const agent = { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } };

function makeSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-action-skill-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  return dir;
}

function restoreExitCode(previousExitCode: typeof process.exitCode): void {
  process.exitCode = previousExitCode;
}

describe("sandbox skill action orchestration", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();

    ensureLiveSandboxOrExit.mockResolvedValue(undefined);
    getSessionAgent.mockReturnValue(agent);
    skillInstall.validateSkillName.mockReturnValue(true);
    skillInstall.resolveSkillPaths.mockReturnValue(paths);
    skillInstall.checkExisting.mockReturnValue(true);
    skillInstall.removeSkill.mockReturnValue({
      success: true,
      removedUploadDir: true,
      removedMirrorDir: true,
      clearedSessions: true,
      messages: [],
    });
    skillInstall.verifyRemove.mockReturnValue(true);
    skillInstall.parseFrontmatter.mockReturnValue({ name: "demo-skill" });
    skillInstall.collectFiles.mockReturnValue({
      files: ["SKILL.md"],
      skippedDotfiles: [],
      unsafePaths: [],
    });
    skillInstall.uploadDirectory.mockReturnValue({
      uploaded: 1,
      failed: [],
      skippedDotfiles: [],
      unsafePaths: [],
    });
    skillInstall.postInstall.mockReturnValue({ success: true, messages: [] });
    skillInstall.verifyInstall.mockReturnValue(true);
  });

  afterEach(() => {
    restoreExitCode(previousExitCode);
    vi.restoreAllMocks();
  });

  it("treats unknown skill existence as fatal for remove", async () => {
    skillInstall.checkExisting.mockImplementation((ctx) => {
      expect(ctx).toEqual({ sandboxName: "alpha" });
      return null;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  Could not check if skill 'demo-skill' exists — sandbox may be unreachable.",
    );
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
  });

  it("reports an absent skill for remove", async () => {
    skillInstall.checkExisting.mockImplementation((ctx) => {
      expect(ctx).toEqual({ sandboxName: "alpha" });
      return false;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Skill 'demo-skill' is not installed in sandbox 'alpha'.");
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
  });

  it("removes and verifies an existing skill", async () => {
    skillInstall.checkExisting.mockImplementation((ctx, resolvedPaths) => {
      expect(ctx).toEqual({ sandboxName: "alpha" });
      expect(resolvedPaths).toBe(paths);
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(getSessionAgent).toHaveBeenCalledWith("alpha");
    expect(skillInstall.resolveSkillPaths).toHaveBeenCalledWith(agent, "demo-skill");
    expect(skillInstall.removeSkill).toHaveBeenCalledWith(
      { sandboxName: "alpha" },
      paths,
    );
    expect(skillInstall.verifyRemove).toHaveBeenCalledWith(
      { sandboxName: "alpha" },
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' removed"));
    expect(process.exitCode).toBeUndefined();
  });

  it("continues skill install when the existence probe is unknown because upload plus verify are authoritative", async () => {
    const skillDir = makeSkillDir();
    skillInstall.checkExisting.mockImplementation((ctx) => {
      expect(ctx).toEqual({ sandboxName: "alpha" });
      return null;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Warning: could not check sandbox for existing skill — treating as fresh install.",
      ),
    );
    expect(skillInstall.uploadDirectory).toHaveBeenCalledWith(
      { sandboxName: "alpha" },
      skillDir,
      paths.uploadDir,
    );
    expect(skillInstall.verifyInstall).toHaveBeenCalledWith(
      { sandboxName: "alpha" },
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' installed"));
    expect(process.exitCode).toBeUndefined();
  });
});
