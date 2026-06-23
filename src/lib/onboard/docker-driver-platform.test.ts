// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isLinuxDockerDriverGatewayEnabled,
  resolveGatewayRegistrationEndpoint,
  resolveGatewayRuntime,
} from "./docker-driver-platform";

describe("isLinuxDockerDriverGatewayEnabled", () => {
  it("is enabled on Linux and on macOS arm64", () => {
    expect(isLinuxDockerDriverGatewayEnabled("linux", "x64")).toBe(true);
    expect(isLinuxDockerDriverGatewayEnabled("darwin", "arm64")).toBe(true);
  });

  it("is disabled on macOS x64 and on Windows", () => {
    expect(isLinuxDockerDriverGatewayEnabled("darwin", "x64")).toBe(false);
    expect(isLinuxDockerDriverGatewayEnabled("win32", "x64")).toBe(false);
  });
});

describe("resolveGatewayRuntime", () => {
  // The Docker driver is the default for every host. Podman is an opt-in path
  // gated on an explicit operator signal AND a Docker-driver-enabled platform;
  // the preflight runtime guard separately requires a reachable podman socket.
  it("defaults to docker when no opt-in is present", () => {
    expect(resolveGatewayRuntime({ env: {}, platform: "linux", arch: "x64" })).toBe("docker");
  });

  it("selects podman on Linux when NEMOCLAW_GATEWAY_RUNTIME=podman", () => {
    expect(
      resolveGatewayRuntime({
        env: { NEMOCLAW_GATEWAY_RUNTIME: "podman" },
        platform: "linux",
        arch: "x64",
      }),
    ).toBe("podman");
  });

  it("accepts a case-insensitive, whitespace-padded opt-in value", () => {
    expect(
      resolveGatewayRuntime({
        env: { NEMOCLAW_GATEWAY_RUNTIME: "  Podman  " },
        platform: "linux",
        arch: "x64",
      }),
    ).toBe("podman");
  });

  it("keeps docker for an explicit docker opt-in", () => {
    expect(
      resolveGatewayRuntime({
        env: { NEMOCLAW_GATEWAY_RUNTIME: "docker" },
        platform: "linux",
        arch: "x64",
      }),
    ).toBe("docker");
  });

  it("ignores an unrecognized runtime value and keeps the docker default", () => {
    expect(
      resolveGatewayRuntime({
        env: { NEMOCLAW_GATEWAY_RUNTIME: "containerd" },
        platform: "linux",
        arch: "x64",
      }),
    ).toBe("docker");
  });

  it("falls back to docker when podman is requested on a non-docker-driver platform", () => {
    expect(
      resolveGatewayRuntime({
        env: { NEMOCLAW_GATEWAY_RUNTIME: "podman" },
        platform: "win32",
        arch: "x64",
      }),
    ).toBe("docker");
  });
});

describe("resolveGatewayRegistrationEndpoint", () => {
  // `openshell gateway add <endpoint> --local` imports the local mTLS client
  // bundle. The endpoint scheme must follow the runtime's TLS posture: the
  // opt-in podman runtime is mTLS-ON (https), the Docker default keeps its
  // historical http endpoint. Picking the wrong scheme on podman leaves the CLI
  // with no client cert and every sandbox-create fails the TLS handshake.
  it("registers the https endpoint for the podman runtime", () => {
    expect(
      resolveGatewayRegistrationEndpoint({
        runtime: "podman",
        httpsEndpoint: "https://127.0.0.1:8080",
        httpEndpoint: "http://127.0.0.1:8080",
      }),
    ).toBe("https://127.0.0.1:8080");
  });

  it("keeps the http endpoint for the docker runtime", () => {
    expect(
      resolveGatewayRegistrationEndpoint({
        runtime: "docker",
        httpsEndpoint: "https://127.0.0.1:8080",
        httpEndpoint: "http://127.0.0.1:8080",
      }),
    ).toBe("http://127.0.0.1:8080");
  });
});
