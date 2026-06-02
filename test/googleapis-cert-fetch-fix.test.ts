// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const PRELOAD = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "scripts",
  "googleapis-cert-fetch-fix.js",
);

type FetchCall = { input: unknown; init: Record<string, unknown> | undefined };

function loadPreloadWith(recorder: (call: FetchCall) => unknown): typeof globalThis.fetch {
  // The preload runs once on require; bust the cache so each scenario re-runs it.
  delete require.cache[require.resolve(PRELOAD)];
  const stub = ((input: unknown, init?: Record<string, unknown>) => {
    recorder({ input, init });
    return Promise.resolve({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test override of global fetch
  (globalThis as any).fetch = stub;
  require(PRELOAD);
  return globalThis.fetch;
}

describe("googleapis-cert-fetch-fix preload (#4687)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSandbox: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSandbox = process.env.OPENSHELL_SANDBOX;
    process.env.OPENSHELL_SANDBOX = "1";
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore global fetch
    (globalThis as any).fetch = originalFetch;
    if (originalSandbox === undefined) delete process.env.OPENSHELL_SANDBOX;
    else process.env.OPENSHELL_SANDBOX = originalSandbox;
  });

  it("strips the per-request dispatcher for Google signing-cert endpoints", async () => {
    const calls: FetchCall[] = [];
    const fetch = loadPreloadWith((call) => calls.push(call));
    const dispatcher = { sentinel: true };

    await fetch(
      "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com",
      // biome-ignore lint/suspicious/noExplicitAny: undici dispatcher option
      { dispatcher, headers: { accept: "application/json" } } as any,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].init).toBeDefined();
    expect(calls[0].init).not.toHaveProperty("dispatcher");
    // Other init fields are preserved.
    expect(calls[0].init).toMatchObject({ headers: { accept: "application/json" } });
  });

  it("strips the per-request agent for the oauth2 and x509 cert paths", async () => {
    const calls: FetchCall[] = [];
    const fetch = loadPreloadWith((call) => calls.push(call));

    for (const url of [
      "https://www.googleapis.com/oauth2/v1/certs",
      "https://www.googleapis.com/robot/v1/metadata/x509/foo%40bar",
    ]) {
      // biome-ignore lint/suspicious/noExplicitAny: undici agent option
      await fetch(url, { agent: { sentinel: true } } as any);
    }

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init).not.toHaveProperty("agent");
    }
  });

  it("leaves non-Google requests untouched", async () => {
    const calls: FetchCall[] = [];
    const fetch = loadPreloadWith((call) => calls.push(call));
    const dispatcher = { sentinel: true };

    // biome-ignore lint/suspicious/noExplicitAny: undici dispatcher option
    await fetch("https://example.com/oauth2/v1/certs", { dispatcher } as any);
    // Google host but unrelated path is also untouched.
    // biome-ignore lint/suspicious/noExplicitAny: undici dispatcher option
    await fetch("https://www.googleapis.com/storage/v1/b/bucket", { dispatcher } as any);

    expect(calls).toHaveLength(2);
    expect(calls[0].init).toHaveProperty("dispatcher", dispatcher);
    expect(calls[1].init).toHaveProperty("dispatcher", dispatcher);
  });

  it("does not wrap fetch outside the sandbox", () => {
    process.env.OPENSHELL_SANDBOX = "0";
    const before = globalThis.fetch;
    const after = loadPreloadWith(() => undefined);
    // loadPreloadWith installs its own stub before requiring; the preload must
    // not replace it when OPENSHELL_SANDBOX !== "1".
    expect(after).toBe(globalThis.fetch);
    expect(before).not.toBe(after); // sanity: the stub was installed
    // biome-ignore lint/suspicious/noExplicitAny: preload marks wrapped fns
    expect((after as any).__nemoclawGoogleCertFix).toBeUndefined();
  });
});
