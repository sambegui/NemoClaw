// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Wires `ensureResumeProviderReady` (in `./resume-provider-recovery`) to the
// dependencies it needs. Lives outside `src/lib/onboard.ts` so the wiring
// doesn't count against the entrypoint-budget gate.

import { DEFAULT_ROUTE_CREDENTIAL_ENV } from "../inference/config";
import { hydrateCredentialEnv } from "./credential-env";
import { validateNvidiaApiKeyValue } from "../validation";
import {
  ensureResumeProviderReady as ensureResumeProviderReadyImpl,
  type ResumeProviderRecoveryDeps,
} from "./resume-provider-recovery";

const onboardProviders = require("./providers") as {
  REMOTE_PROVIDER_CONFIG: ResumeProviderRecoveryDeps["remoteProviderConfig"];
  getProviderLabel: ResumeProviderRecoveryDeps["getProviderLabel"];
};

// Lazy require for the symbols that live in `../onboard` itself — avoids a
// circular module load. By the time `ensureResumeProviderReady` is called,
// the onboard.ts module has finished loading and its exports are populated.
type OnboardExports = {
  isRoutedInferenceProvider: ResumeProviderRecoveryDeps["isRoutedInferenceProvider"];
  providerExistsInGateway: ResumeProviderRecoveryDeps["providerExistsInGateway"];
  isNonInteractive: ResumeProviderRecoveryDeps["isNonInteractive"];
  note: ResumeProviderRecoveryDeps["note"];
  replaceNamedCredential: ResumeProviderRecoveryDeps["replaceNamedCredential"];
};

export async function ensureResumeProviderReady(
  provider: string | null | undefined,
  credentialEnv: string | null | undefined,
): Promise<{ forceInferenceSetup: boolean }> {
  const o = require("../onboard") as OnboardExports;
  return ensureResumeProviderReadyImpl(provider, credentialEnv, {
    remoteProviderConfig: onboardProviders.REMOTE_PROVIDER_CONFIG,
    defaultRouteCredentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
    isRoutedInferenceProvider: o.isRoutedInferenceProvider,
    providerExistsInGateway: o.providerExistsInGateway,
    hydrateCredentialEnv,
    getProviderLabel: onboardProviders.getProviderLabel,
    isNonInteractive: o.isNonInteractive,
    note: o.note,
    replaceNamedCredential: o.replaceNamedCredential,
    validateNvidiaApiKeyValue,
    log: (m) => console.log(m),
    warn: (m) => console.error(m),
    exit: (c) => process.exit(c),
  });
}
