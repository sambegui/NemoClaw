// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const WARMUP_SESSION_ID_PREFIX = "nemoclaw-onboard-warmup-";

export function isWarmupSessionId(sessionId: string): boolean {
  return sessionId.startsWith(WARMUP_SESSION_ID_PREFIX);
}
