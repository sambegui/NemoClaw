// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const STORE_DIST_PATH = require.resolve("../../../dist/lib/credentials/store");
const originalHome = process.env.HOME;
const trackedKeys = ["NVIDIA_API_KEY", "OPENAI_API_KEY", "PATH"];
let tempDirs: string[] = [];

type StoreModule = typeof import("../../../dist/lib/credentials/store");

function loadStore(home: string): StoreModule {
  process.env.HOME = home;
  delete require.cache[STORE_DIST_PATH];
  return require(STORE_DIST_PATH) as StoreModule;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nemoclaw-creds-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, ".nemoclaw"), { recursive: true });
  return home;
}

afterEach(() => {
  delete require.cache[STORE_DIST_PATH];
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const key of trackedKeys) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("credential store helpers", () => {
  it("normalizes, stages, lists, resolves, and deletes process credentials", () => {
    const store = loadStore(makeHome());
    expect(store.normalizeCredentialValue("  abc\r\n")).toBe("abc");
    expect(store.normalizeCredentialValue(null)).toBe("");

    store.saveCredential("NVIDIA_API_KEY", "  nv-key  ");
    store.saveCredential("PATH", "not listed");
    expect(store.getCredential("NVIDIA_API_KEY")).toBe("nv-key");
    expect(store.loadCredentials()).toEqual({ NVIDIA_API_KEY: "nv-key" });
    expect(store.listCredentialKeys()).toEqual(["NVIDIA_API_KEY"]);
    expect(store.resolveProviderCredential("NVIDIA_API_KEY")).toBe("nv-key");
    expect(store.deleteCredential("NVIDIA_API_KEY")).toBe(true);
    expect(store.deleteCredential("NVIDIA_API_KEY")).toBe(false);
  });

  it("stages only allowlisted legacy credentials without overriding explicit env", () => {
    const home = makeHome();
    process.env.NVIDIA_API_KEY = "explicit";
    writeFileSync(
      join(home, ".nemoclaw", "credentials.json"),
      JSON.stringify({ NVIDIA_API_KEY: "legacy", OPENAI_API_KEY: " openai ", PATH: "evil" }),
    );
    const store = loadStore(home);

    expect(store.stageLegacyCredentialsToEnv()).toEqual(["OPENAI_API_KEY"]);
    expect(process.env.NVIDIA_API_KEY).toBe("explicit");
    expect(process.env.OPENAI_API_KEY).toBe("openai");
    expect(process.env.PATH).not.toBe("evil");
  });

  it("refuses unsafe HOME directories", () => {
    const store = loadStore("/tmp");
    expect(() => store.resolveHomeDir()).toThrow(/world-readable/);
  });

  it("securely removes legacy credentials files and dangling credential symlinks", () => {
    const home = makeHome();
    const legacyFile = join(home, ".nemoclaw", "credentials.json");
    writeFileSync(legacyFile, JSON.stringify({ NVIDIA_API_KEY: "legacy" }));
    const store = loadStore(home);

    store.removeLegacyCredentialsFile();
    expect(() => lstatSync(legacyFile)).toThrow();

    const target = join(home, "target-secret");
    writeFileSync(target, "do-not-touch");
    symlinkSync(target, legacyFile);
    store.removeLegacyCredentialsFile();
    expect(readFileSync(target, "utf-8")).toBe("do-not-touch");
    expect(() => lstatSync(legacyFile)).toThrow();
  });

  it("removes empty legacy credentials but preserves migratable or malformed files", () => {
    const home = makeHome();
    const legacyFile = join(home, ".nemoclaw", "credentials.json");
    const store = loadStore(home);

    writeFileSync(legacyFile, "  ");
    expect(store.removeLegacyCredentialsFileIfEmpty()).toBe(true);

    writeFileSync(legacyFile, JSON.stringify({ PATH: "ignored", NVIDIA_API_KEY: "" }));
    expect(store.removeLegacyCredentialsFileIfEmpty()).toBe(true);

    writeFileSync(legacyFile, JSON.stringify({ NVIDIA_API_KEY: "legacy" }));
    expect(store.removeLegacyCredentialsFileIfEmpty()).toBe(false);
    expect(readFileSync(legacyFile, "utf-8")).toContain("NVIDIA_API_KEY");

    writeFileSync(legacyFile, "not-json");
    expect(store.removeLegacyCredentialsFileIfEmpty()).toBe(false);
  });

  it("leaves oversized legacy credential files for manual inspection", () => {
    const home = makeHome();
    const legacyFile = join(home, ".nemoclaw", "credentials.json");
    writeFileSync(legacyFile, " ".repeat(1024 * 1024 + 1));
    chmodSync(legacyFile, 0o600);
    const store = loadStore(home);

    expect(store.stageLegacyCredentialsToEnv()).toEqual([]);
    expect(store.removeLegacyCredentialsFileIfEmpty()).toBe(false);
  });
});
