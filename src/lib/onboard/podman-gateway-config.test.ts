// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildPodmanGatewayConfigToml, writePodmanGatewayConfig } from "./podman-gateway-config";

describe("buildPodmanGatewayConfigToml", () => {
  // The keystone of the podman path: the OPENSHELL_DOCKER_SUPERVISOR_IMAGE env
  // var does NOT pin the supervisor image on the podman compute driver — only
  // the gateway.toml supervisor_image key binds it. So the toml carries both
  // compute_drivers = ["podman"] and a version-matched supervisor_image.
  it("selects the podman compute driver and pins the supervisor image", () => {
    const toml = buildPodmanGatewayConfigToml({
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor:0.0.44",
      podmanSocketPath: "/run/user/1000/podman/podman.sock",
      grpcEndpoint: "https://127.0.0.1:8080",
      sandboxBin: "/usr/bin/openshell-sandbox",
    });

    expect(toml).toContain('compute_drivers = ["podman"]');
    expect(toml).toContain('supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.0.44"');
    expect(toml).toContain('socket = "/run/user/1000/podman/podman.sock"');
    expect(toml).toContain('grpc_endpoint = "https://127.0.0.1:8080"');
    expect(toml).toContain('supervisor_bin = "/usr/bin/openshell-sandbox"');
    expect(toml).toContain("[openshell.drivers.podman]");
    // mTLS-on: the docker path's TLS-disabling toggles never appear here.
    expect(toml).not.toContain("disable_tls");
  });

  it("accepts a digest-pinned supervisor image", () => {
    const toml = buildPodmanGatewayConfigToml({
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:" + "0".repeat(64),
      podmanSocketPath: "/run/user/1000/podman/podman.sock",
      grpcEndpoint: "https://127.0.0.1:8080",
      sandboxBin: "/usr/bin/openshell-sandbox",
    });

    expect(toml).toContain("@sha256:");
    expect(toml).toContain('compute_drivers = ["podman"]');
  });
});

describe("writePodmanGatewayConfig", () => {
  it("writes ~/.config/openshell/gateway.toml with 0600 perms", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-toml-"));
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    try {
      const written = writePodmanGatewayConfig({
        supervisorImage: "ghcr.io/nvidia/openshell/supervisor:0.0.44",
        podmanSocketPath: "/run/user/1000/podman/podman.sock",
        grpcEndpoint: "https://127.0.0.1:8080",
        sandboxBin: "/usr/bin/openshell-sandbox",
      });

      const expectedPath = path.join(tempHome, ".config", "openshell", "gateway.toml");
      expect(written).toBe(expectedPath);
      const contents = fs.readFileSync(expectedPath, "utf-8");
      expect(contents).toContain('compute_drivers = ["podman"]');
      expect(contents).toContain('supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.0.44"');
      expect(fs.statSync(expectedPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(expectedPath)).mode & 0o777).toBe(0o700);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
