# T3 Fleet

Self-hosted orchestration of disposable T3 Code environments on homelab machines. See
`docs/fleet/architecture.md` (repository root) for the approved system design and
`.workspaces/t3-fleet/` for the phase plans and handoffs.

Fleet is a **standalone pnpm workspace** with its own lockfile. It is deliberately not part of the
root workspace and never imports `@t3tools/*` packages — T3 Code is consumed exclusively through
the `t3` CLI and its HTTP APIs.

## Packages

| Package               | Role                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/controller` | Control plane: HTTP API, agent WebSocket endpoint, SQLite persistence, nodes + image registry, tailnet integration |
| `packages/agent`      | Per-node daemon: joins the controller, heartbeats, runs the docker/sysbox environment driver                       |
| `packages/shared`     | Protocol schemas (message envelope, node/capacity/environment/image types) shared by all sides                     |
| `image/`              | The `t3env` base image: Dockerfile (pinned ARGs), entrypoint, build script — see `image/README.md`                 |
| `deploy/`             | Operator docs: tailnet setup, ACL policy, OAuth client — see `deploy/tailscale.md`                                 |

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
`environmentHealthTimeoutMillis`, `tailscaleApiUrl`, `tsAuthKeyTtlSeconds`,
`tailnetJoinTimeoutMillis`, `tailnetEndpointScheme`; env equivalents `FLEET_CONTROLLER_HOST`,
`FLEET_CONTROLLER_PORT`, `FLEET_CONTROLLER_DATA_DIR`, `FLEET_CONTROLLER_HEARTBEAT_INTERVAL_MS`,
`FLEET_CONTROLLER_JOIN_TOKEN_TTL_SECONDS`, `FLEET_CONTROLLER_STATUS_POLL_INTERVAL_MS`,
`FLEET_CONTROLLER_ENVIRONMENT_HEALTH_TIMEOUT_MS`, `FLEET_CONTROLLER_TAILSCALE_API_URL`,
`FLEET_CONTROLLER_TS_AUTHKEY_TTL_SECONDS`, `FLEET_CONTROLLER_TAILNET_JOIN_TIMEOUT_MS`,
`FLEET_CONTROLLER_TAILNET_ENDPOINT_SCHEME` (`https`; the `http` value exists only for
integration tests that fake the tailnet). The Tailscale OAuth client itself is runtime state,
not config — see `deploy/tailscale.md` and the settings endpoints below.

Agent — file path from `FLEET_AGENT_CONFIG`; keys `controllerUrl`, `nodeName`, `stateDir`,
`joinToken`, `dockerRuntime`, `snapshotRetention`, `helperImage`; env equivalents
`FLEET_AGENT_CONTROLLER_URL`, `FLEET_AGENT_NODE_NAME`, `FLEET_AGENT_STATE_DIR`,
`FLEET_AGENT_JOIN_TOKEN`, `FLEET_AGENT_DOCKER_RUNTIME`, `FLEET_AGENT_SNAPSHOT_RETENTION`,
`FLEET_AGENT_HELPER_IMAGE`.

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
`image/README.md`. Containers publish no ports on the node: every environment is reached over
its own tailnet HTTPS endpoint.

## Tailnet networking

Every environment is its own tailnet device named `env-<id>`, published at
`https://env-<id>.<tailnet>.ts.net/` via `t3 serve --tailscale-serve`. The controller mints a
single-use, pre-authorized, non-ephemeral `tag:t3-env` auth key per environment through the
operator's Tailscale OAuth client (`PUT /api/settings/tailscale`; the secret lives in the
vault), discovers the device after the first join, and deletes it through the API on destroy.
`tailscaled` state lives on the environment volume, so the device identity — and therefore the
URL — survives restarts, suspends, and image updates; a rejoin never mints a second key. Setup,
required scopes, and the recommended ACL policy for `tag:t3-controller` / `tag:t3-node` /
`tag:t3-env` are documented in `deploy/tailscale.md`.

## HTTP API

| Endpoint                                  | Description                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `GET /healthz`                            | Liveness                                                                  |
| `GET /api/nodes`                          | Node inventory with derived health and live capacity                      |
| `POST /api/join-tokens`                   | Mint a single-use join token (`{ "ttlSeconds"?: n }`)                     |
| `GET /api/images`                         | Registered base images                                                    |
| `POST /api/images`                        | Register an image reference (`{ "reference": "t3env:0.1.0" }`)            |
| `POST /api/images/:id/current`            | Make an image the one new environments use                                |
| `POST /api/images/:id/pull`               | Pull on one node (`{ "nodeId"?: "..." }`) or every connected node         |
| `GET /api/environments`                   | Environment inventory (desired/observed state, endpoint, activity)        |
| `POST /api/environments`                  | Create (`{ "gitUrl", "gitBranch"?, "nodeId"?, "name"? }`) — async; poll   |
| `GET /api/environments/:id`               | One environment, including its create step and last observed status       |
| `POST /api/environments/:id/pairing-link` | Mint a one-time `/pair#token=...` URL (returned once, never stored)       |
| `POST /api/environments/:id/destroy`      | Destroy (`{ "archive"?: bool }` archives uncommitted work first)          |
| `GET /api/settings/tailscale`             | Tailscale OAuth status (`{configured, clientId, tag}` — never the secret) |
| `PUT /api/settings/tailscale`             | Store/replace the OAuth client (`{clientId, clientSecret, tag?}`)         |
| `GET /ws/agent`                           | Agent WebSocket endpoint (protocol in `packages/shared`)                  |

## Environment lifecycle

`POST /api/environments` schedules the environment onto a node (explicit `nodeId` or the
connected node with the most free memory) and returns immediately; a persisted step machine
(`scheduled → image-ready → key-minted → created → started → tailnet-joined → healthy →
session-issued → ready`) drives the create in the background and survives controller restarts
(startup reconciliation resumes whatever was mid-flight — a resumed create past `key-minted`
reuses the recorded auth key, never minting a second one). The container entrypoint joins the
tailnet (`tailscaled` state on the volume), clones the repo, runs the repo's `.t3env/setup.sh`
hook when present, registers the workspace with `t3 project add`, and starts `t3 serve` with
Tailscale Serve publication (see `image/README.md`). While waiting for the first HTTPS answer
(certificate issuance can take a minute) the environment's `statusDetail` reports the wait
instead of failing.

After the T3 server answers its descriptor endpoint over the tailnet URL, the controller execs
`t3 auth session issue --json --label fleet-controller` once, stores the admin session in the
encrypted vault, and from then on talks to the environment over HTTPS only: status polling
(`/.well-known/t3/environment` + `/api/orchestration/snapshot`) and pairing-link minting
(`POST /api/auth/pairing-token`). Destroy optionally archives the uncommitted diff, revokes the
controller's session, removes the container and volume, deletes the tailnet device, and deletes
the vault secrets.
