// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../manifest";
import { filterEnabledPlanEntries } from "./plan-filter";
import type { MessagingPolicyApplyOptions, MessagingPolicyApplyResult } from "./types";

export function applyPolicyAtOpenShell(
  plan: SandboxMessagingPlan,
  options: MessagingPolicyApplyOptions,
): MessagingPolicyApplyResult {
  const activeEntries = filterEnabledPlanEntries(plan, plan.networkPolicy.entries);
  const activeTemplates = filterEnabledPlanEntries(plan, plan.networkPolicy.templates ?? []);
  const activePresets = uniqueStrings(activeEntries.map((entry) => entry.presetName));
  const activeTemplatePresets = uniqueStrings(activeTemplates.map((entry) => entry.presetName));
  const activePolicyKeys = uniqueStrings([
    ...activeEntries.flatMap((entry) => entry.policyKeys),
    ...activeTemplates.flatMap((entry) => entry.policyKeys),
  ]);
  if (
    activePresets.length > 0 &&
    !options.applyPresets(plan.sandboxName, activePresets, {
      agent: plan.agent,
      entries: activeEntries,
      policyKeys: activePolicyKeys,
    })
  ) {
    throw new Error(`Failed to apply messaging policy preset(s): ${activePresets.join(", ")}`);
  }

  if (activeTemplates.length > 0 && !options.applyPresetContent) {
    throw new Error(
      `Cannot apply generated messaging policy template(s): ${activeTemplatePresets.join(", ")}`,
    );
  }

  for (const template of activeTemplates) {
    if (
      !options.applyPresetContent?.(plan.sandboxName, template.presetName, template.content, {
        agent: plan.agent,
        entries: activeEntries,
        policyKeys: activePolicyKeys,
      })
    ) {
      throw new Error(`Failed to apply generated messaging policy: ${template.presetName}`);
    }
  }

  return {
    appliedPresets: activePresets,
    appliedPolicyKeys: activePolicyKeys,
    ...(activeTemplatePresets.length > 0 ? { appliedTemplatePresets: activeTemplatePresets } : {}),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
