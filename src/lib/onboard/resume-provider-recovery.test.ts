// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ensureResumeProviderReady,
  type RemoteProviderConfigEntry,
  type ResumeProviderRecoveryDeps,
} from "./resume-provider-recovery";

const COMPATIBLE_ENDPOINT_CONFIG: RemoteProviderConfigEntry = {
  label: "Compatible Endpoint",
  providerName: "compatible-endpoint",
  providerType: "openai",
  credentialEnv: "COMPATIBLE_API_KEY",
  endpointUrl: "https://example/v1",
  helpUrl: null,
  modelMode: "input",
  defaultModel: "test-model",
};

type DepsRecorder = {
  log: string[];
  warn: string[];
  note: string[];
  exitCalls: number[];
  replaceCalls: Array<{ env: string; label: string }>;
  deps: ResumeProviderRecoveryDeps;
};

function makeDeps(overrides: {
  providerExists?: boolean;
  credentialValue?: string | undefined;
  nonInteractive?: boolean;
  remoteProviderConfig?: Record<string, RemoteProviderConfigEntry>;
}): DepsRecorder {
  const log: string[] = [];
  const warn: string[] = [];
  const note: string[] = [];
  const exitCalls: number[] = [];
  const replaceCalls: Array<{ env: string; label: string }> = [];
  const deps: ResumeProviderRecoveryDeps = {
    remoteProviderConfig: overrides.remoteProviderConfig ?? {
      compatible: COMPATIBLE_ENDPOINT_CONFIG,
    },
    defaultRouteCredentialEnv: "OPENAI_API_KEY",
    isRoutedInferenceProvider: () => false,
    providerExistsInGateway: () => overrides.providerExists ?? true,
    hydrateCredentialEnv: () => overrides.credentialValue,
    getProviderLabel: (key) => key,
    isNonInteractive: () => overrides.nonInteractive ?? false,
    log: (m) => log.push(m),
    warn: (m) => warn.push(m),
    note: (m) => note.push(m),
    exit: (code) => exitCalls.push(code),
    replaceNamedCredential: async (env, label) => {
      replaceCalls.push({ env, label });
      return "fresh-key";
    },
    validateNvidiaApiKeyValue: () => null,
  };
  return { log, warn, note, exitCalls, replaceCalls, deps };
}

describe("ensureResumeProviderReady", () => {
  it("returns false-forced when no provider is set (nothing to recover)", async () => {
    const { deps } = makeDeps({ providerExists: false });
    const result = await ensureResumeProviderReady(null, null, deps);
    expect(result.forceInferenceSetup).toBe(false);
  });

  it("returns false-forced when the provider is unknown and not a routed provider", async () => {
    const { deps } = makeDeps({ providerExists: false });
    const result = await ensureResumeProviderReady("mystery-provider", null, deps);
    expect(result.forceInferenceSetup).toBe(false);
  });

  it("returns false-forced when the provider still exists in the gateway", async () => {
    const { deps } = makeDeps({ providerExists: true });
    const result = await ensureResumeProviderReady("compatible-endpoint", "COMPATIBLE_API_KEY", deps);
    expect(result.forceInferenceSetup).toBe(false);
  });

  it("emits a [resume] note and forces inference setup when credential is already hydrated", async () => {
    const recorder = makeDeps({
      providerExists: false,
      credentialValue: "already-hydrated-key",
    });
    const result = await ensureResumeProviderReady(
      "compatible-endpoint",
      "COMPATIBLE_API_KEY",
      recorder.deps,
    );
    expect(result.forceInferenceSetup).toBe(true);
    expect(recorder.note.join("\n")).toContain("[resume]");
    expect(recorder.replaceCalls).toHaveLength(0);
  });

  it("re-prompts for credentials when the provider was reset and credential is missing (#3278)", async () => {
    const recorder = makeDeps({
      providerExists: false,
      credentialValue: undefined,
    });
    const result = await ensureResumeProviderReady(
      "compatible-endpoint",
      "COMPATIBLE_API_KEY",
      recorder.deps,
    );
    expect(result.forceInferenceSetup).toBe(true);
    expect(recorder.replaceCalls).toEqual([
      { env: "COMPATIBLE_API_KEY", label: "Compatible Endpoint API key" },
    ]);
    expect(recorder.exitCalls).toEqual([]);
  });

  it("exits 1 in non-interactive mode when the provider is missing and no credential is set", async () => {
    const recorder = makeDeps({
      providerExists: false,
      credentialValue: undefined,
      nonInteractive: true,
    });
    await ensureResumeProviderReady("compatible-endpoint", "COMPATIBLE_API_KEY", recorder.deps);
    expect(recorder.exitCalls).toEqual([1]);
    expect(recorder.warn.join("\n")).toContain("COMPATIBLE_API_KEY");
    expect(recorder.warn.join("\n")).toContain("during resume");
    expect(recorder.replaceCalls).toHaveLength(0);
  });
});
