// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PodmanGatewayConfigOptions {
  supervisorImage: string;
  podmanSocketPath: string;
  grpcEndpoint: string;
  sandboxBin?: string | null;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

// Build the OpenShell gateway.toml for the podman compute driver.
//
// This file — not an environment variable — is what binds the podman driver.
// On the podman driver the OPENSHELL_DOCKER_SUPERVISOR_IMAGE env var does not
// pin the supervisor image, so the version-matched (or digest-pinned)
// supervisor_image MUST live here alongside compute_drivers = ["podman"].
// TLS is left on (no disable_tls toggle): the podman path targets mTLS, with
// the gateway's own ExecStartPre cert generation and `gateway add --local`
// CLI registration handling the trust setup.
export function buildPodmanGatewayConfigToml(options: PodmanGatewayConfigOptions): string {
  const podmanEntries: [string, string | undefined | null][] = [
    ["grpc_endpoint", options.grpcEndpoint],
    ["socket", options.podmanSocketPath],
    ["supervisor_image", options.supervisorImage],
    ["supervisor_bin", options.sandboxBin],
  ];
  const podmanConfig = podmanEntries
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
    )
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join("\n");

  return [
    "[openshell]",
    "version = 1",
    "",
    "[openshell.gateway]",
    'compute_drivers = ["podman"]',
    "",
    "[openshell.drivers.podman]",
    podmanConfig,
    "",
  ].join("\n");
}

export function getPodmanGatewayConfigPath(): string {
  return path.join(os.homedir(), ".config", "openshell", "gateway.toml");
}

// Write ~/.config/openshell/gateway.toml for the podman driver with the same
// restrictive 0700 dir / 0600 file permissions the gateway.env override uses.
export function writePodmanGatewayConfig(options: PodmanGatewayConfigOptions): string {
  const configDir = path.join(os.homedir(), ".config", "openshell");
  const configPath = path.join(configDir, "gateway.toml");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  fs.writeFileSync(configPath, buildPodmanGatewayConfigToml(options), {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.chmodSync(configPath, 0o600);
  return configPath;
}
