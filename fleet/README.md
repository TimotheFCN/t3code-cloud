# T3 Fleet

Self-hosted orchestration of disposable T3 Code environments on homelab machines. See
`docs/fleet/architecture.md` (repository root) for the approved system design and
`.workspaces/t3-fleet/` for the phase plans and handoffs.

Fleet is a **standalone pnpm workspace** with its own lockfile. It is deliberately not part of the
root workspace and never imports `@t3tools/*` packages — T3 Code is consumed exclusively through
the `t3` CLI and its HTTP APIs.

## Packages

| Package               | Role                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/controller` | Control plane: HTTP API, agent WebSocket endpoint, SQLite persistence, nodes + image registry      |
| `packages/agent`      | Per-node daemon: joins the controller, heartbeats, runs the docker/sysbox environment driver       |
| `packages/shared`     | Protocol schemas (message envelope, node/capacity/environment/image types) shared by all sides     |
| `image/`              | The `t3env` base image: Dockerfile (pinned ARGs), entrypoint, build script — see `image/README.md` |

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
`heartbeatIntervalMillis`, `joinTokenTtlSeconds`, `statusPollIntervalMillis`,
`environmentHealthTimeoutMillis`; env equivalents `FLEET_CONTROLLER_HOST`,
`FLEET_CONTROLLER_PORT`, `FLEET_CONTROLLER_DATA_DIR`, `FLEET_CONTROLLER_HEARTBEAT_INTERVAL_MS`,
`FLEET_CONTROLLER_JOIN_TOKEN_TTL_SECONDS`, `FLEET_CONTROLLER_STATUS_POLL_INTERVAL_MS`,
`FLEET_CONTROLLER_ENVIRONMENT_HEALTH_TIMEOUT_MS`.

Agent — file path from `FLEET_AGENT_CONFIG`; keys `controllerUrl`, `nodeName`, `stateDir`,
`joinToken`, `advertiseHost`, `dockerRuntime`, `snapshotRetention`, `helperImage`; env
equivalents `FLEET_AGENT_CONTROLLER_URL`, `FLEET_AGENT_NODE_NAME`, `FLEET_AGENT_STATE_DIR`,
`FLEET_AGENT_JOIN_TOKEN`, `FLEET_AGENT_ADVERTISE_HOST`, `FLEET_AGENT_DOCKER_RUNTIME`,
`FLEET_AGENT_SNAPSHOT_RETENTION`, `FLEET_AGENT_HELPER_IMAGE`. `advertiseHost` is the host the
controller uses to reach container ports published on the node (phase-3 node-port endpoints);
when unset, the controller uses the agent connection's remote address. Phase 4 replaces
node-port endpoints with per-environment tailnet URLs.

The controller is the only stateful component: SQLite under `dataDir` (forward-only migrations
applied at start), the encrypted vault under `dataDir/vault/` (an `age` identity file, mode 0600,
plus `secrets.json` holding encrypted payloads keyed by ref — nothing secret rests in plaintext),
and destroy-time final-work archives under `dataDir/archives/`. The agent's local state is
`<stateDir>/credential.json` (mode 0600) plus volume snapshot tarballs under
`<stateDir>/snapshots/<envId>/`.

## The docker driver

The agent runs environments as Docker containers under the **sysbox** runtime
(`dockerRuntime: "sysbox-runc"` by default) so each one gets a working inner Docker daemon
without `--privileged`. When the runtime is missing the driver fails with a diagnostic — it never
falls back to a privileged container; setting `FLEET_AGENT_DOCKER_RUNTIME=runc` is an explicit,
unsupported opt-out used by tests and development.

The driver is stateless: containers and volumes carry `t3fleet.*` labels
(`t3fleet.environment-id`, ...) and every read derives from them, so an agent restart re-adopts
running environments without any bookkeeping. One named volume per environment
(`t3env-<id>-home`) mounts at `/root` — the durability contract is documented in
`image/README.md`.

## HTTP API (phases 1–3)

| Endpoint                                  | Description                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `GET /healthz`                            | Liveness                                                                |
| `GET /api/nodes`                          | Node inventory with derived health and live capacity                    |
| `POST /api/join-tokens`                   | Mint a single-use join token (`{ "ttlSeconds"?: n }`)                   |
| `GET /api/images`                         | Registered base images                                                  |
| `POST /api/images`                        | Register an image reference (`{ "reference": "t3env:0.1.0" }`)          |
| `POST /api/images/:id/current`            | Make an image the one new environments use                              |
| `POST /api/images/:id/pull`               | Pull on one node (`{ "nodeId"?: "..." }`) or every connected node       |
| `GET /api/environments`                   | Environment inventory (desired/observed state, endpoint, activity)      |
| `POST /api/environments`                  | Create (`{ "gitUrl", "gitBranch"?, "nodeId"?, "name"? }`) — async; poll |
| `GET /api/environments/:id`               | One environment, including its create step and last observed status     |
| `POST /api/environments/:id/pairing-link` | Mint a one-time `/pair#token=...` URL (returned once, never stored)     |
| `POST /api/environments/:id/destroy`      | Destroy (`{ "archive"?: bool }` archives uncommitted work first)        |
| `GET /ws/agent`                           | Agent WebSocket endpoint (protocol in `packages/shared`)                |

## Environment lifecycle (phase 3)

`POST /api/environments` schedules the environment onto a node (explicit `nodeId` or the
connected node with the most free memory) and returns immediately; a persisted step machine
(`scheduled → image-ready → created → started → healthy → session-issued → ready`) drives the
create in the background and survives controller restarts (startup reconciliation resumes
whatever was mid-flight). The container entrypoint clones the repo, runs the repo's
`.t3env/setup.sh` hook when present, registers the workspace with `t3 project add`, and starts
`t3 serve` (see `image/README.md`).

After the T3 server answers its descriptor endpoint, the controller execs
`t3 auth session issue --json --label fleet-controller` once, stores the admin session in the
encrypted vault, and from then on talks to the environment over HTTP only: status polling
(`/.well-known/t3/environment` + `/api/orchestration/snapshot`) and pairing-link minting
(`POST /api/auth/pairing-token`). Destroy optionally archives the uncommitted diff, revokes the
controller's session, removes the container and volume, and deletes the vault secret.
