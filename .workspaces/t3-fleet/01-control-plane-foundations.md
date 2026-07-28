# Phase 1 — Control-Plane Foundations

## Prompt

> Build the T3 Fleet control-plane foundations: the standalone `fleet/` workspace, the controller
> service with SQLite persistence and node inventory, the agent skeleton with the join flow and
> the controller↔agent WebSocket protocol, and the driver interface. Start by reading
> `.workspaces/t3-fleet/README.md`, `product-brief.md`, `current-state.md` (§1, §10),
> `architecture.md` (§1–§5), `docs/fleet/architecture.md` in full, and every `*.handoff.md` in
> that folder. Read `.repos/effect-smol/LLMS.md` before writing Effect code. Explore the codebase,
> write your own plan, and execute. When done and validated, write
> `.workspaces/t3-fleet/01-control-plane-foundations.handoff.md`.

## Goal

A controller process and an agent process exist and know about each other. An operator can start
the controller, issue a join token, start an agent with it, and see the node registered, healthy,
and heartbeating in the controller's API. Nothing runs environments yet, but every later phase has
a home: persistence, protocol, config, and the driver seam are in place.

## Scope

- **`fleet/` workspace scaffolding**: own pnpm workspace + lockfile, `controller`, `agent`,
  `shared` packages (dashboard comes in phase 6), TypeScript + Effect, vitest, a `fleet/README.md`
  documenting the dev commands. Do not touch root workspace files.
- **Controller service**: config loading (env + file), SQLite persistence with ordered
  forward-only migrations (`nodes`, `join_tokens`, `events`), an HTTP API skeleton with health and
  node-inventory endpoints, and the agent WebSocket endpoint.
- **Join flow**: single-use, expiring join tokens minted through the API; agents exchange the
  token for a per-node credential on first connect; reconnection uses the credential. Token and
  credential storage follows `architecture.md` §4.
- **Agent skeleton**: config, outbound WebSocket with reconnect/backoff, heartbeat with capacity
  snapshot (CPU, memory, disk), protocol version check at join.
- **Protocol package** (`fleet/packages/shared`): schema-validated message envelope with
  correlation ids for request/response and event streams, versioned from day one
  (`architecture.md` §2).
- **Driver interface**: define the interface exactly as `architecture.md` §2 lists it, with a
  stub/fake driver used by tests. The real docker driver is phase 2.
- Decide and document: SQLite driver choice, WS envelope details, config file format.

Out of scope: Docker driver and base image (phase 2), environment lifecycle (phase 3), tailnet
integration (phase 4), vault (phase 5), dashboard UI (phase 6).

## Guidelines

- The controller is the only stateful component; the agent must be safely restartable at any time
  with no local state beyond its credential and config.
- Effect idioms per `.repos/effect-smol/` (services via `Context`, `Layer` composition,
  `SubscriptionRef` for observable state); mirror the test style used in `infra/relay/src` for
  boundary-faking rather than internal mocking.
- Keep the protocol strictly typed in `shared` — the dashboard will consume the same schemas.

## Validation

- Automated: `fleet/` unit + integration tests — join-token lifecycle (single-use, expiry),
  agent join/reconnect against an in-process controller, protocol version rejection, heartbeat
  persistence, migration idempotency. Type-check and lint clean inside `fleet/`.
- Manual: run controller + agent locally (two processes), issue a join token via the API, watch
  the node register and heartbeat; kill and restart the agent and verify credential-based rejoin.
- Automated coverage required for: join/credential security paths (single-use enforcement, bad
  credential rejection).
