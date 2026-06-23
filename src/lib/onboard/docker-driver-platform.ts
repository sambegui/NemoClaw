// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type GatewayComputeRuntime = "docker" | "podman";

export function isLinuxDockerDriverGatewayEnabled(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return platform === "linux" || (platform === "darwin" && arch === "arm64");
}

// Resolve the OpenShell compute runtime for the gateway. Docker is the default
// on every host. Podman is an explicit, additive opt-in: the operator sets
// NEMOCLAW_GATEWAY_RUNTIME=podman, and the platform must already run the
// Docker-driver gateway path. Anything other than an exact "podman" opt-in —
// unset, "docker", or an unrecognized value — keeps the Docker default, so the
// historical behavior is unchanged for every existing install. Socket
// reachability is enforced separately by the preflight runtime guard.
export function resolveGatewayRuntime(
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {},
): GatewayComputeRuntime {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const requested = String(env.NEMOCLAW_GATEWAY_RUNTIME ?? "")
    .trim()
    .toLowerCase();
  const optedIntoPodman =
    requested === "podman" && isLinuxDockerDriverGatewayEnabled(platform, arch);
  return optedIntoPodman ? "podman" : "docker";
}

// Pick the `openshell gateway add <endpoint> --local` registration endpoint for
// the runtime's TLS posture. The podman runtime is mTLS-ON (https) so the CLI
// imports the local mTLS client bundle; the Docker default keeps its historical
// http endpoint. Pure helper so the scheme choice is testable without the
// onboarding monolith.
export function resolveGatewayRegistrationEndpoint(opts: {
  runtime: GatewayComputeRuntime;
  httpsEndpoint: string;
  httpEndpoint: string;
}): string {
  return opts.runtime === "podman" ? opts.httpsEndpoint : opts.httpEndpoint;
}
