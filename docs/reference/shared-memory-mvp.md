---
title:
  page: "OpenShell Shared Agent Memory MVP"
  nav: "Shared Memory MVP"
description:
  main: "Design proposal for a Redis-backed OpenShell shared memory driver that lets heterogeneous agents exchange durable, scoped memory events."
  agent: "Describes the proposed OpenShell shared agent memory MVP, including repo boundaries, Redis Streams backend, API contract, security model, pull-delivery subscriptions, and the OpenClaw plus Hermes acceptance demo. Use when designing cross-agent memory for OpenClaw, Hermes, and future agent runtimes."
keywords: ["shared agent memory", "agent memory fabric", "redis streams", "openclaw hermes memory"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "hermes", "redis", "memory", "architecture"]
content:
  type: reference
  difficulty: technical_advanced
  audience: ["developer", "engineer"]
status: draft
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# OpenShell Shared Agent Memory MVP

This document proposes an MVP for shared memory across heterogeneous agents using OpenShell as the driver boundary.
NemoClaw is the reference integration environment, not the owner of the durable memory primitive.
The target scenario is one OpenClaw sandbox and one Hermes sandbox sharing durable updates through an OpenShell-managed memory API backed by Redis Streams.

The design treats pub-sub as a delivery pattern, not the memory system itself.
The durable product primitive is an append-only memory event log with queryable views, subscriptions, acknowledgements, provenance, and policy enforcement.
In the MVP, subscriptions use pull delivery: `subscribe` creates a durable filtered inbox and `poll` pulls pending events from that inbox.

## Problem

NemoClaw can manage multiple sandboxes and multiple agent runtimes, but each sandbox currently owns its own workspace and memory files.
That works for a single assistant, but it does not provide a clean coordination model when different agents need to collaborate.

Examples include:

- An OpenClaw agent discovers a project convention and a Hermes agent needs that convention for planning.
- A Hermes agent updates task state and an OpenClaw agent needs the latest status before taking action.
- A monitoring agent finds a security issue and all coding agents should see the finding.
- Multiple sandboxes should share selected durable facts without mounting the same writable filesystem.

Shared filesystem memory is not a strong enough abstraction.
It creates race conditions, couples agents to one file layout, and makes provenance, replay, policy, and audit hard to enforce.

## Goals

The MVP should provide a shared memory fabric with these properties:

- Agent-neutral API.
- Redis Streams backend for durable event delivery.
- Pull-based subscriptions with acknowledgement.
- Queryable memory events by scope, topic, subject, and time.
- Provenance on every memory event.
- Secret scanning and schema validation before persistence.
- No Redis credentials inside agent sandboxes.
- OpenClaw and Hermes adapters that use the same API contract.
- NemoClaw integration that configures the backend and demonstrates two-agent sharing.

## Non-Goals

The MVP should not implement every memory capability at once.

The first version should not include:

- Vector search.
- Distributed consensus.
- Multi-region replication.
- Automatic conflict resolution across semantic facts.
- Agent ranking or trust scoring beyond basic provenance fields.
- Direct Redis access from agent processes.
- A permanent NemoClaw-owned memory implementation.

## Value Proposition

Shared memory gives heterogeneous agents shared situational awareness without forcing them to use the same runtime, workspace layout, or internal memory model.

For operators, the value is continuity across sandboxes and agent runtimes.
For agent developers, the value is a stable integration contract.
For platform maintainers, the value is a single policy and audit boundary for durable agent memory.

The strongest product statement is:

> Shared Agent Memory provides durable, scoped, auditable memory exchange for heterogeneous agents through an agent-neutral API.

## Ownership Boundaries

The MVP should be implemented across three ownership layers.

| Layer | Owner | Responsibilities |
|---|---|---|
| Memory platform | OpenShell | Memory API, Redis driver, auth, policy, sandbox-safe endpoint, event delivery, replay, and acknowledgement. |
| Reference integration | NemoClaw | Onboarding configuration, policy preset, adapter installation, docs, examples, and an OpenClaw plus Hermes demo. |
| Agent adapters | Agent runtimes | Runtime-specific mapping between shared memory and each agent's native tools, context, sessions, or memory model. |

NemoClaw should not own shared memory semantics.
NemoClaw should configure and demonstrate the platform primitive.

OpenShell should own the durable memory service because it already owns sandbox identity, gateway mediation, provider delivery, policy, and runtime integration boundaries.

## System Architecture

The MVP uses a memory service in front of Redis.
Agents call the memory service through an OpenShell-managed endpoint.
The memory service validates requests, applies policy, scans for secrets, writes to Redis Streams, and exposes query and subscription APIs.

```text
OpenClaw adapter        Hermes adapter        Future agent adapter
      |                       |                       |
      +----------- Shared Memory API -----------------+
                          |
                 OpenShell memory service
                          |
                 Redis Streams memory driver
```

Agents must not connect directly to Redis.
The service boundary keeps credentials, policy, validation, and audit independent of any specific agent runtime.

## Repository Plan

### OpenShell

OpenShell should hold the core memory primitive.

Proposed files:

```text
crates/openshell-server/src/memory.rs
crates/openshell-sandbox/src/memory_local.rs
```

Expected updates:

```text
Cargo.toml
Cargo.lock
crates/openshell-server/Cargo.toml
crates/openshell-sandbox/Cargo.toml
crates/openshell-server/src/lib.rs
crates/openshell-server/src/http.rs
crates/openshell-sandbox/src/lib.rs
crates/openshell-sandbox/src/proxy.rs
```

The MVP starts HTTP-first to avoid committing a protobuf/gRPC contract too early.
The `memory.local` route is sandbox-local and forwards only `/v1/memory/*` calls to the gateway.
Redis remains behind the gateway driver.

Later production hardening can split the server module into:

```text
crates/openshell-server/src/memory/mod.rs
crates/openshell-server/src/memory/store.rs
crates/openshell-server/src/memory/redis.rs
crates/openshell-server/src/memory/types.rs
proto/memory.proto
crates/openshell-server/src/grpc/memory.rs
```

### NemoClaw

NemoClaw should configure and demonstrate shared memory.
It should also package the OpenClaw adapter for the reference OpenClaw sandbox because NemoClaw owns the OpenClaw sandbox image and plugin assets in this branch.
That adapter should remain thin and portable so it can move if OpenClaw later owns the plugin directly.

Current MVP files:

```text
src/lib/shared-memory.ts
src/lib/shared-memory.test.ts
src/lib/onboard.ts
src/lib/onboard/dockerfile-patch.ts
src/lib/state/registry.ts
src/lib/inventory/index.ts
src/lib/inventory/index.test.ts
scripts/generate-openclaw-config.py
Dockerfile
test/registry.test.ts
nemoclaw-blueprint/openclaw-plugins/shared-memory/
docs/reference/shared-memory-mvp.md
examples/shared-memory/
```

A dedicated network policy preset can follow once the OpenShell sandbox-facing route is finalized.

The NemoClaw MVP should support environment-driven configuration first.
CLI flags can follow once the OpenShell API stabilizes.

```text
NEMOCLAW_SHARED_MEMORY=redis
OPENSHELL_MEMORY_REDIS_URL=redis://...
NEMOCLAW_SHARED_MEMORY_SCOPE=workspace:nemoclaw
```

### Agent Adapters

OpenClaw and Hermes should each receive a thin adapter.
The adapter maps shared memory APIs into the runtime's native tool, memory, session, or planning model.

The adapter should expose the same conceptual operations for every runtime:

```text
shared_memory_publish
shared_memory_query
shared_memory_subscribe
shared_memory_poll
shared_memory_ack
```

The OpenClaw adapter currently lives in NemoClaw under `nemoclaw-blueprint/openclaw-plugins/shared-memory/`.
That placement is appropriate for the MVP because NemoClaw builds the OpenClaw sandbox image and can conditionally install the adapter when shared memory is enabled.
The Hermes adapter currently lives in the Hermes repo and is exercised by the local demo through `examples/shared-memory/hermes-agent.py`.
Both adapters call the same OpenShell memory API and neither adapter receives Redis credentials.

## API Contract

The initial service contract should be intentionally small.

```text
PublishMemoryEvent
QueryMemoryEvents
CreateMemorySubscription
PollMemorySubscription
AckMemoryEvents
```

An HTTP facade can map those operations to these routes:

```text
POST /v1/memory/events
GET  /v1/memory/query
POST /v1/memory/subscriptions
GET  /v1/memory/subscriptions/{id}/poll
POST /v1/memory/subscriptions/{id}/ack
```

The first implementation can expose gateway APIs directly.
The sandbox-friendly target should be `memory.local`, similar in spirit to routed inference.

```text
http://memory.local/v1/memory/events
http://memory.local/v1/memory/query
http://memory.local/v1/memory/subscriptions/{id}/poll
```

## Event Schema

A memory event is append-only.
Events may later produce materialized views, but the original event should remain the audit source.

```json
{
  "id": "evt_01j...",
  "type": "release.blocker.detected",
  "scope": "workspace:nemoclaw",
  "subject": "shared-memory-mvp/hermes-adapter-smoke",
  "content": {
    "summary": "The Hermes adapter smoke path must pass before the shared-memory MVP demo is marked ready.",
    "recommendation": "Validate subscribe, pull, acknowledge, and response publishing against the OpenShell memory driver."
  },
  "provenance": {
    "agent_id": "openclaw:main",
    "runtime": "openclaw",
    "sandbox_id": "openclaw-demo",
    "source": "agent_observation"
  },
  "visibility": "shared",
  "sensitivity": "normal",
  "schema_version": 1,
  "created_at": "2026-05-14T00:00:00Z"
}
```

Required fields:

| Field | Purpose |
|---|---|
| `id` | Stable event identifier assigned by the memory service. |
| `type` | Dot-delimited topic-like event type. |
| `scope` | Sharing boundary such as `workspace:nemoclaw` or `project:NemoClaw`. |
| `subject` | Stable entity or topic within the scope. |
| `content` | Structured event payload. |
| `provenance` | Runtime, agent, sandbox, and source information. |
| `visibility` | Sharing level such as `private`, `shared`, or `public`. |
| `sensitivity` | Policy hint such as `normal`, `confidential`, or `secret_candidate`. |
| `schema_version` | Version for forward-compatible parsing. |
| `created_at` | Service-side timestamp. |

## Scope Model

Scopes define where an event can be queried and which subscribers can receive it.

Initial scopes:

| Scope Prefix | Example | Purpose |
|---|---|---|
| `user` | `user:aniket` | Preferences and user-level context. |
| `workspace` | `workspace:nemoclaw` | Shared workspace memory across sandboxes. |
| `project` | `project:NemoClaw` | Repository or project facts. |
| `sandbox` | `sandbox:openclaw-demo` | Runtime-local observations that may be promoted later. |

Scope names should be explicit.
Agents should not publish to a global default scope unless the operator configured one.

## Subscription Model

Subscriptions should be pull-based in the MVP.
Push notifications can be added later as a wake-up optimization.

Pull-based delivery is a better first contract because agents can be offline, restarted, busy, or rate-limited.
The service retains unacknowledged events until subscribers poll and acknowledge them.
In this document and demo, `poll` means "pull pending events from my durable subscription inbox."
It is not an extra query step after subscribing.
The durable subscription stores the filter, cursor, and acknowledgement state; polling only controls when the agent is ready to consume the pending events.
Future delivery modes can add webhooks, server-sent events, WebSockets, or sandbox wakeups without changing the publish event schema.

Example subscription:

```json
{
  "subscription_id": "sub_hermes_planner_project",
  "subscriber": {
    "agent_id": "hermes:planner",
    "runtime": "hermes",
    "sandbox_id": "hermes-demo"
  },
  "scope": "workspace:nemoclaw",
  "filters": {
    "types": ["project.*", "task.*"]
  },
  "delivery": "pull"
}
```

The service should return only events that match the subscription scope and filters.
The subscriber should call `AckMemoryEvents` after it has integrated the event or intentionally ignored it.

## Redis Driver

Redis Streams should be the source of truth for MVP event delivery.
Plain Redis Pub/Sub should not be the source of truth because offline subscribers miss messages.

Recommended Redis keys:

```text
mem:{scope}:events
mem:{scope}:subject:{subject}
mem:{scope}:type:{type}
mem:{scope}:agent:{agent_id}
mem:{scope}:created_at
mem:subscription:{subscription_id}
```

Recommended operations:

| Operation | Redis Command | Purpose |
|---|---|---|
| Publish | `XADD` | Append a memory event to the scoped stream. |
| Create subscription | `XGROUP CREATE MKSTREAM` | Initialize durable delivery state. |
| Poll | `XREADGROUP` | Read pending or new events for a subscriber. |
| Ack | `XACK` | Mark consumed events. |
| Query latest subject view | `HGETALL` | Read materialized current state for a subject. |

The Redis implementation should sit behind a store interface.

```text
MemoryStore
  publish(event)
  query(filter)
  create_subscription(spec)
  poll(subscription_id, limit)
  ack(subscription_id, event_ids)
```

That interface keeps Redis replaceable.
Future drivers could use another stream, queue, database, or hosted memory service.

## Query Model

The MVP query API should support deterministic filters before semantic search.

Initial filters:

- `scope`.
- `type` or type prefix.
- `subject`.
- `agent_id`.
- `sandbox_id`.
- `created_after`.
- `created_before`.
- `limit`.

Vector search should wait until the event and subscription contract is stable.
A later implementation can build an embedding index over accepted memory events or materialized views.

## Agent Adapter Contract

Each agent adapter should do three things:

- Publish durable observations, decisions, and task updates.
- Poll for subscribed updates when the agent is ready to consume them.
- Map shared events into the agent's native memory, prompt context, planning state, or tools.

Adapters should be thin.
They should not own Redis credentials or bypass the memory service.

Adapter configuration:

```text
OPENSHELL_MEMORY_URL=http://memory.local/v1
OPENSHELL_MEMORY_SCOPE=workspace:nemoclaw
AGENT_ID=openclaw:main
SANDBOX_ID=openclaw-demo
```

For OpenClaw, the adapter exposes tool calls that publish, query, subscribe, poll, and acknowledge shared memory.
For Hermes, the adapter can initially be a plugin or sidecar client that maps events into Hermes memories, sessions, plans, or task state.

## NemoClaw Integration

NemoClaw should make the MVP easy to run, but it should not become the memory platform.

The current integration:

- Detects shared-memory configuration during onboarding.
- Validates that the Redis URL is present when Redis mode is selected.
- Keep the Redis URL host-side only.
- Passes only the sandbox-safe memory endpoint, scope, and backend into agent sandboxes.
- Configures the OpenShell memory backend through host-side environment for the MVP.
- Defaults the sandbox-facing memory endpoint to `http://memory.local/v1`.
- Enables the OpenClaw adapter in the sandbox image when shared memory is configured.
- Records shared-memory metadata in the local sandbox registry for status and diagnostics.
- Recreates a sandbox when shared-memory configuration changes, because the runtime environment is set at sandbox creation time.
- Provides a local demo that runs OpenClaw and Hermes adapters against the same OpenShell memory scope.

The Hermes adapter is not implemented in NemoClaw.
The local demo points at the Hermes repo and imports its shared-memory tool.
That split keeps NemoClaw focused on integration while each agent runtime owns its adapter behavior.

The initial user-facing configuration can be environment-driven.

```console
$ NEMOCLAW_SHARED_MEMORY=redis \
  OPENSHELL_MEMORY_REDIS_URL=redis://127.0.0.1:6379 \
  NEMOCLAW_SHARED_MEMORY_SCOPE=workspace:nemoclaw \
  nemoclaw onboard
```

Later CLI support can add explicit flags after the OpenShell contract stabilizes.

## Security Model

Shared memory is a durable data store.
The security bar should be closer to credentials and audit logs than temporary chat context.

The MVP should enforce:

- No Redis credentials in agent sandboxes.
- Service-side schema validation.
- Service-side secret scanning before persistence.
- Per-event provenance.
- Per-scope access checks.
- Deny-by-default sandbox network policy.
- Audit logs for publish, subscription creation, poll, and ack.
- Redaction path for events that should no longer be returned.

The service should reject events that look like API keys, tokens, private keys, or credential files unless an explicit administrative override exists.
The service should record rejection metadata without storing the secret body.

## Conflict Handling

The MVP should not try to automatically resolve semantic conflicts.
It should preserve competing events with provenance.

Example:

- OpenClaw publishes `release.blocker.detected` for `shared-memory-mvp/hermes-adapter-smoke`.
- Hermes publishes another `release.blocker.detected` for the same subject.
- The memory service stores both events.
- A materialized view may mark one as latest, accepted, superseded, or rejected later.

Initial conflict fields:

| Field | Purpose |
|---|---|
| `subject` | Groups related events. |
| `idempotency_key` | Prevents duplicate writes from retries. |
| `supersedes` | Links an event to the event it replaces. |
| `status` | Tracks `proposed`, `accepted`, `superseded`, or `rejected`. |

The default publish status should be `proposed` or `accepted` based on operator policy.
The MVP can start with `accepted` for trusted local demos and add approval workflows later.

## MVP Acceptance Demo

The first demo should prove that the memory fabric works across agent runtimes.
The current local demo is a release-validation handoff:
OpenClaw publishes a release blocker, Hermes receives it through its subscription inbox, Hermes acknowledges it, and Hermes publishes a remediation plan that OpenClaw queries.

Acceptance flow:

1. Start Redis.
2. Start OpenShell with the memory backend enabled.
3. Configure both adapters with the same shared memory scope, `workspace:nemoclaw-demo`.
4. Hermes subscribes to `release.*`.
5. OpenClaw publishes a `release.blocker.detected` event for `shared-memory-mvp/hermes-adapter-smoke`.
6. Hermes pulls its subscription inbox and receives the release blocker.
7. Hermes acknowledges the blocker.
8. Hermes publishes a `release.remediation.planned` event for `hermes:demo`.
9. OpenClaw queries `release.remediation.planned` and sees the Hermes response.
10. Agents use only the OpenShell memory endpoint and scope.
11. Redis credentials stay in the OpenShell gateway process.

For the local MVP demo on a development machine, use:

```console
examples/shared-memory/run-local-demo.sh
```

That script is a working local demo, not only a mock transcript.
It starts Redis, starts the OpenShell gateway from the shared-memory branch, loads the OpenClaw adapter from this NemoClaw branch, loads the Hermes adapter from the configured Hermes repo, and exercises the publish, subscribe, poll, acknowledge, publish, and query flow through OpenShell.
It defaults to:

- OpenShell repo: `/home/ubuntu/anikkulkarni/openshell-features/feat-shared-agent-memory`
- Hermes repo: `/home/ubuntu/anikkulkarni/hermes-agent`
- Redis port: `16379`
- OpenShell gateway port: `18080`
- Scope: `workspace:nemoclaw-demo`

The demo wrappers make the repo boundaries explicit:

- `examples/shared-memory/openclaw-agent.js` loads `nemoclaw-blueprint/openclaw-plugins/shared-memory/index.js`.
- `examples/shared-memory/hermes-agent.py` imports `tools.shared_memory_tool` from the Hermes repo.
- `examples/shared-memory/run-local-demo.sh` starts the Redis container and the OpenShell gateway, then runs both adapters against `http://127.0.0.1:18080/v1`.

The recorded narrated demo is generated from `demo-recordings/remotion-shared-memory`.
Its timeline is intentionally slowed to `1.18x` while the narration plays at the matching reduced rate, so reviewers can follow the terminal panes and voiceover without losing sync.

## Implementation Sequence

Start with the platform contract, then integrate through NemoClaw.
The current branches already implement the early platform, integration, adapter, and demo slices needed for an MVP demo.

Recommended sequence:

1. Add a gateway HTTP memory facade in OpenShell.
2. Add the `MemoryStore` boundary and Redis Streams store behind the same boundary.
3. Add direct gateway smoke tests for publish, subscribe, poll, and ack.
4. Add sandbox-safe `memory.local` routing through the OpenShell sandbox proxy.
5. Add NemoClaw env-driven shared-memory onboarding.
6. Add NemoClaw registry metadata and status output.
7. Add the OpenClaw adapter to the NemoClaw-packaged OpenClaw plugin set.
8. Add the Hermes adapter in the Hermes repo.
9. Add the OpenClaw plus Hermes acceptance demo.
10. Promote the HTTP contract to gRPC/protobuf only if the OpenShell API needs it.

## Open Questions

The MVP should answer these before broadening the design:

- Should OpenShell expose memory only through gRPC first, HTTP first, or both.
- Should OpenShell keep the first contract HTTP-only or add gRPC once the semantics settle.
- Should publish default to `accepted` or `proposed`.
- How should operators configure per-scope access policy.
- How should event redaction interact with Redis Streams retention.
- How should materialized views be rebuilt after schema changes.
- Whether the OpenClaw adapter should remain packaged by NemoClaw or move into an OpenClaw-owned distribution after the MVP.
- Which push delivery mechanism should complement pull subscriptions first.

## Next Steps

- Use this document as the NemoClaw-side design record for the MVP.
- Draft the corresponding OpenShell RFC before adding platform code.
- Keep the first implementation Redis-backed but backend-neutral.
- Keep NemoClaw focused on onboarding, configuration, packaging the OpenClaw adapter, docs, and the cross-agent demo.
- Keep Hermes adapter behavior in the Hermes repo.
