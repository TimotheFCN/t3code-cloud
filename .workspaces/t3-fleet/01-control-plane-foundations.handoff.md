# Phase 1 Handoff — Control-Plane Foundations

Phase 1 is shipped and validated. A controller and an agent exist, know about each other, and the
join/credential/heartbeat loop works end to end (automated tests + manual two-process run).

## What exists now

Everything lives in the standalone `fleet/` pnpm workspace (own lockfile, Effect
`4.0.0-beta.102` pinned to match the root catalog without linking to it; Node >= 24; no build
step — sources run under Node's native type stripping; `.ts`-extension imports throughout, same
tsconfig conventions as the repo root).

```text
fleet/
├── package.json / pnpm-workspace.yaml / pnpm-lock.yaml / tsconfig(.base).json
├── vitest.config.ts / .oxlintrc.json / README.md   # dev commands documented in the README
└── packages/
    ├── shared/src/          # @t3fleet/shared — schemas only
    │   ├── protocol.ts      # PROTOCOL_VERSION, AGENT_SOCKET_PATH, envelope + wire codecs
    │   ├── capacity.ts      # CapacitySnapshot
    │   ├── node.ts          # NodeSummary (the /api/nodes shape the phase-6 dashboard consumes)
    │   └── environment.ts   # EnvironmentDescriptor/State (minimal; phase 2/3 extend)
    ├── controller/src/      # @t3fleet/controller
    │   ├── main.ts          # entrypoint; Controller.ts is the shared Layer composition
    │   ├── Config.ts        # env + JSON file config (ControllerConfig service)
    │   ├── db/              # Database layers, Migrator, migrations/001_init.sql
    │   ├── nodes/           # JoinTokens, NodeRegistry, AgentConnections (req/res correlation)
    │   ├── events/Events.ts # append-only log
    │   └── http/            # Api.ts (HttpApi), AgentSocket.ts (WS endpoint)
    └── agent/src/           # @t3fleet/agent
        ├── main.ts / Config.ts / CredentialStore.ts / Heartbeat.ts
        ├── Connection.ts    # outbound WS, handshake, reconnect/backoff, request handling
        └── driver/          # Driver.ts (interface), FakeDriver.ts (in-memory)
```

Commands (from `fleet/`): `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm controller`, `pnpm agent`.

## Decisions the plan delegated (with rationale)

1. **SQLite driver: `@effect/sql-sqlite-node`** — wraps Node 24's built-in `node:sqlite`
   (`DatabaseSync`): zero native dependencies, Effect-idiomatic `SqlClient`, WAL on by default.
   Migrations are **not** the `@effect/sql` Migrator: plain ordered `NNN_name.sql` files applied
   at startup by `db/Migrator.ts`, tracked in a `migrations` table (forward-only, mirrors
   upstream's convention). Constraint: statements are split on `;` at end-of-line, so migration
   files must not contain triggers or other constructs with embedded semicolons.
2. **WS envelope**: JSON text frames, one discriminated union on `kind` per direction
   (`fleet/packages/shared/src/protocol.ts`):
   - handshake frames `hello` (agent→controller, carries `protocolVersion` and either
     `{ method: "join-token", joinToken }` or `{ method: "credential", nodeId, credential }`),
     `welcome` (carries `nodeId`, the once-only `credential` on token joins, and
     `heartbeatIntervalMillis` — the controller dictates the heartbeat cadence), `rejected`
     (typed reason `protocol-mismatch` / `invalid-token` / `invalid-credential`, then close 1008);
   - `req` (controller→agent, correlation `id`, types `ping` and `list-environments` so the
     correlation machinery is real and tested; phase 2 adds the driver commands here);
   - `res` (`ok: true, payload` / `ok: false, error: { code, message }` — payload is
     `Schema.Unknown` in the envelope, the requester decodes with the per-type payload schema);
   - `event` (agent→controller; only `heartbeat` with a `CapacitySnapshot` today).
3. **Config file format: JSON**, schema-validated, with env-var overrides (env > file > defaults).
   Controller: `FLEET_CONTROLLER_{HOST,PORT,DATA_DIR,HEARTBEAT_INTERVAL_MS,JOIN_TOKEN_TTL_SECONDS,CONFIG}`.
   Agent: `FLEET_AGENT_{CONTROLLER_URL,NODE_NAME,STATE_DIR,JOIN_TOKEN,CONFIG}`.
4. **Lint: standalone `oxlint`** with `require-yield` off (yield-less `Effect.fn` generators are
   idiomatic) and `_tag` allowed for `no-underscore-dangle`.
5. **IDs/secrets**: node ids `node-<12 hex>`, join tokens `fjt_<32B base64url>`, credentials
   `fnc_<32B base64url>`. SHA-256 hashes at rest; credential comparison via
   `crypto.timingSafeEqual` on digests; secrets wrapped in `Redacted` in memory.

## Schema (migration `001_init.sql`)

- `nodes(id, name, join_state, credential_hash, protocol_version, last_seen_at, capacity_json, created_at, updated_at)`
- `join_tokens(id, token_hash UNIQUE, single_use, used_at, expires_at, created_at)`
- `events(id AUTOINCREMENT, occurred_at, kind, node_id, payload_json)` — append-only
- `migrations(name, applied_at)` — migrator bookkeeping

All timestamps are epoch milliseconds. Token consumption is a single atomic
`UPDATE ... WHERE used_at IS NULL AND expires_at > now RETURNING id`, so single-use holds under
concurrency. Node health in `/api/nodes` is derived: `online` iff `last_seen_at` is within
3× `heartbeatIntervalMillis`; `connected` reflects the live WebSocket set (a `SubscriptionRef`
on `NodeRegistry.connectedNodeIds`, ready for dashboard streaming).

## Security paths (all automated-tested)

- Join tokens: single-use enforced over the wire and at the DB layer, expiry enforced, unknown
  tokens rejected, only hashes stored (`JoinTokens.test.ts`, `NodeRegistry.test.ts`,
  `AgentSocket.test.ts`).
- Credentials: issued once inside `welcome`, only the hash persists, bad credential and unknown
  node rejected, timing-safe compare. Agent stores its credential at
  `<stateDir>/credential.json` mode 0600 (asserted in the integration test).
- Protocol version mismatch rejected at hello before any token is consumed.
- Secrets never logged; `Redacted` wrappers throughout.

## HTTP API

`GET /healthz`, `GET /api/nodes` (returns `NodeSummary[]` from shared), `POST /api/join-tokens`
(`{ ttlSeconds? }` 0–86400, default from config, returns plaintext token once). Built with
Effect `HttpApi`; the WS endpoint `GET /ws/agent` is a raw `HttpRouter` route on the same port
doing `request.upgrade`. The API is currently unauthenticated per the architecture (tailnet ACLs
are the v1 access control; binding defaults to 127.0.0.1 until phase 4 brings tailnet binding).

## Driver seam

`fleet/packages/agent/src/driver/Driver.ts` defines exactly the §2 interface
(`createEnvironment`, `startEnvironment`, `stopEnvironment`, `destroyEnvironment`,
`execInEnvironment`, `snapshotVolume`, `listEnvironments`) as a `Context.Service` with typed
errors (`DriverError`, `EnvironmentNotFoundError`). `FakeDriver` is the in-memory implementation
used by tests and wired into `agent/main.ts` as a placeholder. The `list-environments` request
already flows controller → agent → driver → response, so phase 2 mostly swaps the layer and adds
request types.

## Gotchas for later phases

- **pnpm scripts self-install**: pnpm 11 runs a deps check before scripts; unapproved build
  scripts make it fail. `allowBuilds: { msgpackr-extract: false }` in `fleet/pnpm-workspace.yaml`
  handles the one transitive native accelerator (pure-JS fallback is fine). Add new entries there
  if future deps have build scripts.
- **Effect v4 fork semantics**: message handlers in `Socket.runString` each run as their own
  fiber (a `FiberSet`); `Effect.forkChild` from a handler dies with the handler. Use
  `Effect.forkScoped` (the agent's heartbeat does this — it lives in the connection scope and is
  interrupted when the socket loop ends).
- **Test teardown ordering**: fork test fixtures (agents, raw sockets) into a scope that closes
  _before_ `Effect.provide(<server layer>)` unwinds (`Effect.scoped` around the test body), or
  the Node HTTP server's graceful shutdown waits ~20s for live WS connections and the interrupt
  surfaces as a bogus test failure. The integration layer also sets
  `gracefulShutdownTimeout: "250 millis"`.
- **`node:sqlite` RETURNING** works (used by token consumption); streaming queries do not.
- **Reconnect/backoff semantics** (`agent/src/Connection.ts`): failures before `welcome` retry
  with jittered exponential backoff capped at 30s; drops after `welcome` are treated as clean
  ends (backoff resets, reconnect after 1s). `rejected` frames and a missing token+credential are
  fatal — the process exits; the operator re-issues a token.
- The controller tells agents how often to heartbeat (`heartbeatIntervalMillis` in `welcome`) —
  tests crank it down; don't hardcode cadence anywhere else.

## Tests added (23, all green)

- `shared/src/protocol.test.ts` — envelope round-trips, malformed-frame rejection.
- `controller/src/nodes/JoinTokens.test.ts` — mint/consume, single-use, expiry, unknown token,
  hash-at-rest.
- `controller/src/nodes/NodeRegistry.test.ts` — token registration + consumption, credential
  auth (good/bad/unknown), hash-at-rest, heartbeat persistence, health derivation
  (online/offline), live-connection tracking.
- `controller/src/db/Migrator.test.ts` — schema creation, idempotency across two "starts" on the
  same database file.
- `agent/src/driver/FakeDriver.test.ts` — full driver contract, unknown-environment errors.
- `controller/src/http/AgentSocket.test.ts` — integration against an in-process controller on an
  ephemeral port with the real agent: token join → registration + heartbeats + capacity +
  credential file (0600) + ping/list-environments over correlation ids; kill + credential rejoin
  without token; protocol-version rejection; unknown-token rejection; single-use over the wire;
  bad-credential rejection.

## Validation performed

- `pnpm typecheck`, `pnpm lint`, `pnpm test` all clean inside `fleet/`.
- Manual two-process run: controller on :9412, token minted via `curl`, agent joined (hostname as
  node name), `/api/nodes` showed `online`/`connected` with capacity; SIGKILL'd the agent →
  `connected: false, health: offline`; restarted with no token → credential rejoin as the same
  node id, no duplicate row; processes stopped and temp state removed afterwards.
- **Not verifiable in this environment**: nothing for this phase — no sysbox, tailnet, or real
  multi-node hardware is exercised yet. Phase 2+ carry those obligations.

## Notes to later phases

- **Phase 2 (docker driver)**: implement `Driver` behind the existing interface; add your
  controller→agent request types to `shared/src/protocol.ts` (extend `ControllerRequest` and add
  payload schemas) and handle them in `agent/src/Connection.ts` `respond`. Your `images` /
  `environments` migrations go in `controller/src/db/migrations/002_*.sql` — the migrator picks
  them up by filename order. `EnvironmentDescriptor` in shared is deliberately minimal — extend it.
- **Phase 3 (lifecycle)**: `AgentConnections.request` is the controller-side entry point for
  commands; it handles correlation, timeouts (10s default — revisit for long-running commands
  like pulls; consider a per-request timeout parameter), and disconnect cleanup. Long-running
  operations likely want progress _events_ rather than one response — the `event` frame side of
  the envelope is where those belong.
- **Phase 6 (dashboard)**: consume `NodeSummary` from `@t3fleet/shared/node`;
  `NodeRegistry.connectedNodeIds` is a `SubscriptionRef` you can stream. `Events.list` backs the
  activity view (`events` table).
- **Phase 8 (packaging)**: the controller currently binds `127.0.0.1` by default — the
  deploy story must set `FLEET_CONTROLLER_HOST` appropriately (tailnet interface). `join.sh`
  should pass `FLEET_AGENT_CONTROLLER_URL`, `FLEET_AGENT_JOIN_TOKEN`, and a persistent
  `FLEET_AGENT_STATE_DIR` volume; everything else has workable defaults.
