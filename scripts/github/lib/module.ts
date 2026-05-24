// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** ESM entrypoint detection that also works for .ts files run by node --experimental-strip-types. */

import { pathToFileURL } from "node:url";

export function isMainModule(importMetaUrl: string): boolean {
  const argvPath = process.argv[1];
  return argvPath !== undefined && pathToFileURL(argvPath).href === importMetaUrl;
}
