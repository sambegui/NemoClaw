// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  ChannelPolicyPresetReference,
  ChannelPolicyPresetSpec,
  SandboxMessagingInputReference,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingNetworkPolicyPlan,
} from "../../manifest";
import type { ManifestCompilerContext } from "../types";
import { renderPolicyTemplate } from "./policy-template-renderer";

export function planNetworkPolicy(
  manifests: readonly ChannelManifest[],
  context: ManifestCompilerContext,
  inputRegistry: ReadonlyMap<string, readonly SandboxMessagingInputReference[]> = new Map(),
): SandboxMessagingNetworkPolicyPlan {
  const entries = manifests.flatMap((manifest) => planManifestPolicyEntries(manifest, context));
  const templates = manifests.flatMap((manifest) =>
    (manifest.policyTemplates ?? []).flatMap((template) => {
      const rendered = renderPolicyTemplate(
        manifest.id,
        template,
        context.agent,
        inputRegistry.get(manifest.id) ?? [],
      );
      return rendered ? [rendered] : [];
    }),
  );
  return {
    presets: unique(entries.map((entry) => entry.presetName)),
    entries,
    ...(templates.length > 0 ? { templates } : {}),
  };
}

function planManifestPolicyEntries(
  manifest: ChannelManifest,
  context: ManifestCompilerContext,
): SandboxMessagingNetworkPolicyEntryPlan[] {
  return (manifest.policyPresets ?? []).map((preset) => {
    const policy = normalizePolicyPreset(preset);
    const agentPolicyKeys = policy.agentPolicyKeys?.[context.agent];
    if (agentPolicyKeys) {
      return {
        channelId: manifest.id,
        presetName: policy.name,
        policyKeys: agentPolicyKeys,
        source: "agent-alias",
      };
    }

    return {
      channelId: manifest.id,
      presetName: policy.name,
      policyKeys: policy.policyKeys ?? [policy.name],
      source: "manifest",
    };
  });
}

function normalizePolicyPreset(preset: ChannelPolicyPresetReference): ChannelPolicyPresetSpec {
  return typeof preset === "string" ? { name: preset } : preset;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
