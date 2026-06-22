// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { filterEnabledPlanEntries } from "../messaging/applier/plan-filter";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import * as policies from "../policy";
import * as registry from "../state/registry";

export function applyGeneratedMessagingPolicyTemplates(
  sandboxName: string,
  plan: SandboxMessagingPlan | null | undefined,
  options: {
    readonly channelId?: string | null;
    readonly sourcePath?: string;
  } = {},
): string[] {
  if (!plan || plan.sandboxName !== sandboxName) return [];
  const activeTemplates = filterEnabledPlanEntries(plan, plan.networkPolicy.templates ?? []).filter(
    (template) => !options.channelId || template.channelId === options.channelId,
  );
  const applied: string[] = [];
  for (const template of activeTemplates) {
    const ok = policies.applyPresetContent(sandboxName, template.presetName, template.content, {
      custom: { sourcePath: options.sourcePath ?? `messaging:${template.channelId}` },
    });
    if (!ok) {
      throw new Error(`Failed to apply generated messaging policy: ${template.presetName}`);
    }
    applied.push(template.presetName);
  }
  return [...new Set(applied)];
}

export function applyGeneratedMessagingPolicyTemplatesFromRegistry(
  sandboxName: string,
  options: {
    readonly channelId?: string | null;
  } = {},
): string[] {
  const plan = registry.getHydratedMessagingPlanFromEntry(registry.getSandbox(sandboxName));
  return applyGeneratedMessagingPolicyTemplates(sandboxName, plan, options);
}
