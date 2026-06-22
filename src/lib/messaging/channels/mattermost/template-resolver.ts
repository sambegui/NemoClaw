// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  nonEmptyObject,
  nonEmptyString,
  parseBoolean,
  parseList,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

type MattermostGroupConfig = {
  readonly requireMention?: boolean;
};

export const resolveMattermostTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  switch (reference) {
    case "mattermostConfig.baseUrl":
      return resolvedRenderTemplateReference(mattermostBaseUrl(context));
    case "mattermostConfig.requireMention":
      return resolvedRenderTemplateReference(mattermostRequireMention(context));
    case "mattermostConfig.openclawChatmode":
      return resolvedRenderTemplateReference(mattermostOpenClawChatmode(context));
    case "mattermostConfig.openclawGroupPolicy":
      return resolvedRenderTemplateReference(mattermostOpenClawGroupPolicy(context));
    case "mattermostConfig.openclawGroups":
      return resolvedRenderTemplateReference(nonEmptyObject(mattermostOpenClawGroups(context)));
    case "mattermostConfig.allowedChannels.csv":
      return resolvedRenderTemplateReference(nonEmptyCsv(mattermostAllowedChannels(context)));
    case "mattermostConfig.allowedChannels.values":
      return resolvedRenderTemplateReference(nonEmptyArray(mattermostAllowedChannels(context)));
    default:
      break;
  }

  const allowedIdsReference = reference.match(/^allowedIds[.]mattermost[.](values|csv|dmPolicy)$/);
  if (!allowedIdsReference?.[1]) return undefined;
  const ids = allowedIds(context, "mattermost");
  switch (allowedIdsReference[1]) {
    case "values":
      return resolvedRenderTemplateReference(nonEmptyArray(ids));
    case "csv":
      return resolvedRenderTemplateReference(nonEmptyCsv(ids));
    case "dmPolicy":
      return resolvedRenderTemplateReference(ids.length > 0 ? "allowlist" : undefined);
    default:
      return undefined;
  }
};

function mattermostBaseUrl(context: RenderTemplateContext): string | undefined {
  const raw = nonEmptyString(stateValue(context, "mattermostConfig.baseUrl"));
  if (!raw) return undefined;
  return raw.replace(/\/+$/g, "").replace(/\/api\/v4$/i, "");
}

function mattermostRequireMention(context: RenderTemplateContext): boolean {
  return parseBoolean(stateValue(context, "mattermostConfig.requireMention")) ?? true;
}

function mattermostOpenClawChatmode(context: RenderTemplateContext): "oncall" | "onmessage" {
  return mattermostRequireMention(context) ? "oncall" : "onmessage";
}

function mattermostOpenClawGroupPolicy(
  context: RenderTemplateContext,
): "open" | "allowlist" | undefined {
  if (!mattermostRequireMention(context) && mattermostAllowedChannels(context).length === 0) {
    return "open";
  }
  return mattermostAllowedChannels(context).length > 0 ||
    allowedIds(context, "mattermost").length > 0
    ? "allowlist"
    : undefined;
}

function mattermostOpenClawGroups(
  context: RenderTemplateContext,
): Record<string, MattermostGroupConfig> {
  const channels = mattermostAllowedChannels(context);
  const users = allowedIds(context, "mattermost");
  const requireMention = mattermostRequireMention(context);
  const entry: MattermostGroupConfig = {
    requireMention,
  };
  if (channels.length > 0) {
    return Object.fromEntries(channels.map((channelId) => [channelId, entry]));
  }
  return users.length > 0 || !requireMention ? { "*": entry } : {};
}

function mattermostAllowedChannels(context: RenderTemplateContext): string[] {
  return parseList(stateValue(context, "mattermostConfig.allowedChannels"));
}
