// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Thin process entry point for the native Gemini adapter. All request/translation logic lives
// in (and is tested through) `createGeminiNativeAdapterServer`; this file only reads config from
// the environment and starts the server. The GEMINI_API_KEY and adapter token are read from the
// environment and never logged.

import { createGeminiNativeAdapterServer } from "./gemini-native-adapter";

const apiKey = process.env.GEMINI_API_KEY;
const token = process.env.GEMINI_ADAPTER_TOKEN;
const port = Number(process.env.GEMINI_ADAPTER_PORT || "8801");
const host = process.env.GEMINI_ADAPTER_HOST || "0.0.0.0";

if (!apiKey) {
  console.error("gemini-native-adapter: GEMINI_API_KEY is required");
  process.exit(1);
}
if (!token) {
  console.error("gemini-native-adapter: GEMINI_ADAPTER_TOKEN is required");
  process.exit(1);
}

const server = createGeminiNativeAdapterServer({ apiKey, token });
server.listen(port, host, () => {
  // Never log the key or token — host:port only.
  console.log(`gemini-native-adapter listening on ${host}:${port}`);
});
