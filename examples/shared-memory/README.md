<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Shared Memory Local Demo

This demo runs the MVP on one machine:

- Redis stores the event stream.
- OpenShell gateway exposes the HTTP memory API.
- The OpenClaw adapter publishes and queries through `OPENSHELL_MEMORY_URL`.
- The Hermes adapter subscribes, pulls its subscription inbox, acknowledges, and publishes through the same API.

The scenario is a concrete release handoff: OpenClaw publishes a
`release.blocker.detected` event for the shared-memory MVP because the Hermes
adapter smoke path must be validated before the demo is marked ready. Hermes is
subscribed to `release.*`, pulls its subscription inbox through OpenShell,
acknowledges the blocker, and publishes a `release.remediation.planned` update
that OpenClaw can query.

In this MVP, subscriptions use pull delivery. `subscribe` creates a durable
filtered inbox and cursor; `poll` fetches pending events from that inbox. A
future push delivery mode can add webhooks, server-sent events, or WebSockets
without changing the agent-facing publish and event schema.

```bash
examples/shared-memory/run-local-demo.sh
```

Useful overrides:

```bash
OPENSHELL_REPO=/path/to/OpenShell \
HERMES_REPO=/path/to/hermes-agent \
REDIS_PORT=16379 \
GATEWAY_PORT=18080 \
examples/shared-memory/run-local-demo.sh
```

Set `KEEP_SERVICES=1` to leave Redis and the OpenShell gateway running after the demo prints its validation output.
