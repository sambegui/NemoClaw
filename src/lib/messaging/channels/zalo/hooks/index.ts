// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import type { OpenClawBridgeHealthHookOptions } from "../../openclaw-bridge-health";
import { createZaloOpenClawBridgeHealthHookRegistration } from "./openclaw-bridge-health";

export * from "./openclaw-bridge-health";

export interface ZaloHookOptions {
  readonly openclawBridgeHealth?: OpenClawBridgeHealthHookOptions;
}

export function createZaloHookRegistrations(
  options: ZaloHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [createZaloOpenClawBridgeHealthHookRegistration(options.openclawBridgeHealth)] as const;
}
