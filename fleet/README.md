# T3 Fleet

Self-hosted orchestration of disposable T3 Code environments on homelab machines. See
`docs/fleet/architecture.md` (repository root) for the approved system design and
`.workspaces/t3-fleet/` for the phase plans and handoffs.

Fleet is a **standalone pnpm workspace** with its own lockfile. It is deliberately not part of the
root workspace and never imports `@t3tools/*` packages — T3 Code is consumed exclusively through
the `t3` CLI and its HTTP APIs.

## Packages

| Package               | Role                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `packages/controller` | Control plane: HTTP API, agent WebSocket endpoint, SQLite persistence, node inventory    |
| `packages/agent`      | Per-node daemon: joins the controller, heartbeats, hosts the environment driver          |
| `packages/shared`     | Protocol schemas (message envelope, node/capacity/environment types) shared by all sides |

Stack: TypeScript + Effect v4, Node >= 24 (sources run directly via Node's native type
stripping — no build step), SQLite via `node:sqlite` (`@effect/sql-sqlite-node`).

## Dev commands

All from `fleet/`:

```bash
pnpm install        # install (own lockfile, independent of the repo root)
pnpm typecheck      # tsc --noEmit over all packages
pnpm lint           # oxlint
pnpm test           # vitest (unit + integration; integration spins an in-process controller)
pnpm controller     # run the controller (FLEET_CONTROLLER_* env vars)
pnpm agent          # run the agent (FLEET_AGENT_* env vars)
```

## Running controller + agent locally

```bash
# 1. Start the controller (defaults: 127.0.0.1:9400, data in ./.data/controller)
pnpm controller

# 2. Mint a single-use join token (default TTL 900s)
curl -s -X POST http://127.0.0.1:9400/api/join-tokens \
  -H 'content-type: application/json' -d '{}'

# 3. Start an agent with the token (first join persists a credential under stateDir;
#    restarts after that need no token)
FLEET_AGENT_CONTROLLER_URL=http://127.0.0.1:9400 \
FLEET_AGENT_JOIN_TOKEN=<token> \
pnpm agent

# 4. Watch the node register and heartbeat
curl -s http://127.0.0.1:9400/api/nodes
```

## Configuration

Both processes read (later sources win): built-in defaults, a JSON config file, then environment
variables.

Controller — file path from `FLEET_CONTROLLER_CONFIG`; keys `host`, `port`, `dataDir`,
`heartbeatIntervalMillis`, `joinTokenTtlSeconds`; env equivalents `FLEET_CONTROLLER_HOST`,
`FLEET_CONTROLLER_PORT`, `FLEET_CONTROLLER_DATA_DIR`, `FLEET_CONTROLLER_HEARTBEAT_INTERVAL_MS`,
`FLEET_CONTROLLER_JOIN_TOKEN_TTL_SECONDS`.

Agent — file path from `FLEET_AGENT_CONFIG`; keys `controllerUrl`, `nodeName`, `stateDir`,
`joinToken`; env equivalents `FLEET_AGENT_CONTROLLER_URL`, `FLEET_AGENT_NODE_NAME`,
`FLEET_AGENT_STATE_DIR`, `FLEET_AGENT_JOIN_TOKEN`.

The controller is the only stateful component (SQLite under `dataDir`, forward-only migrations
applied at start). The agent's only local state is `<stateDir>/credential.json` (mode 0600).

## HTTP API (phase 1)

| Endpoint                | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `GET /healthz`          | Liveness                                                 |
| `GET /api/nodes`        | Node inventory with derived health and live capacity     |
| `POST /api/join-tokens` | Mint a single-use join token (`{ "ttlSeconds"?: n }`)    |
| `GET /ws/agent`         | Agent WebSocket endpoint (protocol in `packages/shared`) |
