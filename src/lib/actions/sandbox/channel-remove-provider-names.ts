// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getManifestProviderNamesForChannel,
  getProviderNamesFromMessagingPlan,
  toMessagingAgentId,
  validateBuiltInSandboxMessagingPlan,
  type MessagingAgentDescriptor,
} from "../../messaging";
import type { SandboxEntry } from "../../state/registry";

export type ChannelRemoveProviderNamesResult =
  | { readonly ok: true; readonly providerNames: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function resolveChannelProviderNamesForRemove({
  sandboxName,
  entry,
  channelId,
  agent,
}: {
  readonly sandboxName: string;
  readonly entry: SandboxEntry | null;
  readonly channelId: string;
  readonly agent: MessagingAgentDescriptor;
}): ChannelRemoveProviderNamesResult {
  const plan = entry?.messaging?.plan;
  if (plan) {
    const validation = validateBuiltInSandboxMessagingPlan(plan, {
      sandboxName,
      agent: toMessagingAgentId(agent),
      configuredChannels: Array.isArray(entry?.messagingChannels)
        ? entry.messagingChannels
        : undefined,
      disabledChannels: Array.isArray(entry?.disabledChannels)
        ? entry.disabledChannels
        : undefined,
    });
    if (!validation.ok) {
      return {
        ok: false,
        reason: `stored messaging plan failed validation: ${validation.reason ?? "validation failed"}`,
      };
    }

    const providerNames = getProviderNamesFromMessagingPlan(plan, channelId);
    if (
      providerNames.length > 0 ||
      plan.channels.some((channel) => channel.channelId === channelId)
    ) {
      return { ok: true, providerNames };
    }
  }

  // Pre-plan registry rows still record active channels in messagingChannels.
  // Their gateway providers used deterministic manifest names, so derive those
  // names before allowing local registry/policy cleanup.
  const legacyEnabled = (entry?.messagingChannels || []).includes(channelId);
  if (!legacyEnabled) return { ok: true, providerNames: [] };

  const legacyProviderNames = getManifestProviderNamesForChannel(sandboxName, channelId);
  if (legacyProviderNames === null) {
    return {
      ok: false,
      reason:
        "no messaging plan or manifest is available to identify OpenShell provider cleanup",
    };
  }
  return { ok: true, providerNames: legacyProviderNames };
}
