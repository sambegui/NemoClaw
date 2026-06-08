// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeCredentialValue } from "../credentials/store";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import { hashCredential } from "../security/credential-hash";
import * as registry from "../state/registry";

export interface RecordedMessagingChannelsOptions {
  resume: boolean;
  sessionMessagingChannels?: string[] | null;
  sandboxName: string | null;
  channels: unknown[];
  getCredential(envKey: string): string | null | undefined;
  providerExistsInGateway(name: string): boolean;
  isNonInteractive(): boolean;
}

export function getRecordedMessagingChannelsForResume({
  resume,
  sessionMessagingChannels,
  sandboxName,
  channels,
  getCredential,
  providerExistsInGateway,
  isNonInteractive,
}: RecordedMessagingChannelsOptions): string[] | null {
  return require("./messaging-reuse").getNonInteractiveStoredMessagingChannels(
    resume,
    sessionMessagingChannels,
    sandboxName,
    channels,
    (envKey: string) => Boolean(normalizeCredentialValue(process.env[envKey]) || getCredential(envKey)),
    registry.getSandbox.bind(registry),
    registry.getDisabledChannels.bind(registry),
    providerExistsInGateway,
    isNonInteractive(),
  );
}

export function detectMessagingCredentialRotationFromPlan(
  sandboxName: string,
  plan: SandboxMessagingPlan | null | undefined,
  options: {
    readonly resolveCredential?: (envKey: string) => string | null | undefined;
  } = {},
): { changed: boolean; changedProviders: string[] } {
  if (!plan) return { changed: false, changedProviders: [] };
  const sb = registry.getSandbox(sandboxName);
  const storedBindings = sb?.messaging?.plan?.credentialBindings ?? [];
  const storedHashes: Record<string, string> = {};
  for (const binding of storedBindings) {
    if (binding.credentialHash) storedHashes[binding.providerEnvKey] = binding.credentialHash;
  }
  if (Object.keys(storedHashes).length === 0) return { changed: false, changedProviders: [] };

  const disabled = new Set(plan.disabledChannels);
  const activeChannels = new Set(
    plan.channels
      .filter((channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId))
      .map((channel) => channel.channelId),
  );
  const changedProviders: string[] = [];
  for (const binding of plan.credentialBindings) {
    if (!activeChannels.has(binding.channelId)) continue;
    const storedHash = storedHashes[binding.providerEnvKey];
    if (!storedHash) continue;
    const token = normalizeCredentialValue(
      options.resolveCredential?.(binding.providerEnvKey) ?? process.env[binding.providerEnvKey],
    );
    if (!token) continue;
    if (storedHash !== hashCredential(token)) {
      changedProviders.push(binding.providerName);
    }
  }
  return { changed: changedProviders.length > 0, changedProviders };
}
