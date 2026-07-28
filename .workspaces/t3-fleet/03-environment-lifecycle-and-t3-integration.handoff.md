# Phase 3 Handoff — Environment Lifecycle and T3 Integration

Phase 3 is shipped and validated. The controller now owns the full environment lifecycle against
real T3 servers: create (schedule → pull → container → clone/setup-hook/`t3 project add` →
`t3 serve` → health → admin-session bootstrap), status polling over HTTP, on-demand pairing
links, and a clean destroy — all crash-safe via persisted create steps and startup
reconciliation. Fleet is now T3-aware.

## What changed

```text
fleet/
├── image/
│   ├── entrypoint.sh                        # phase-3 bootstrap: clone → setup hook →
│   │                                        #   t3 project add → t3 serve (all idempotent)
│   └── README.md                            # bootstrap + setup-hook convention documented
└── packages/
    ├── shared/src/
    │   ├── environment.ts                   # + EnvironmentDesiredState/CreateStep/ObservedState,
    │   │                                    #   EnvironmentActivity, EnvironmentSummary, PairingLink
    │   └── protocol.ts                      # + optional `endpointHost` on the hello frame
    ├── agent/src/
    │   ├── Config.ts                        # + advertiseHost (FLEET_AGENT_ADVERTISE_HOST)
    │   ├── Connection.ts                    # hello carries endpointHost
    │   └── driver/
    │       ├── DockerDriver.ts              # pullImage falls back to a local image copy
    │       └── FakeDriver.ts                # makeService + options (ports/exec/onCreate) for tests
    └── controller/src/
        ├── Config.ts                        # + statusPollIntervalMillis, environmentHealthTimeoutMillis
        ├── Controller.ts                    # wires Vault, Scheduler, Environments, StatusPoller,
        │                                    #   PairingLinks, EnvironmentsRepo, FetchHttpClient
        ├── db/migrations/003_environments.sql
        ├── vault/Vault.ts                   # NEW — minimal age-encrypted secrets primitive
        ├── environments/
        │   ├── EnvironmentEndpoints.ts      # NEW — the single URL seam phase 4 swaps
        │   ├── EnvironmentsRepo.ts          # NEW — SQL access to `environments`
        │   ├── Scheduler.ts                 # NEW — explicit node or max-free-memory placement
        │   ├── Environments.ts              # NEW — create/destroy machines + reconciler
        │   ├── StatusPoller.ts              # NEW — descriptor + snapshot polling loop
        │   ├── PairingLinks.ts              # NEW — mint via POST /api/auth/pairing-token
        │   └── T3EnvironmentApi.ts          # NEW — typed HTTP client onto a T3 server
        ├── http/AgentSocket.ts              # records node endpoint host at handshake
        └── http/Api.ts                      # /api/environments endpoints
```

`fleet/README.md` documents the new config keys, API routes, and the lifecycle. New dependency:
`age-encryption@0.3.0` (controller only, pure TS, no build scripts).

## Schema (migration `003_environments.sql`)

- `environments(id, name, node_id → nodes, git_url, git_branch, image_reference, desired_state,
create_step, observed_state, host_port, endpoint_url, t3_session_ref, t3_session_id,
t3_environment_id, activity_json, last_status_at, error, archive_on_destroy, created_at,
updated_at)` — `t3_session_ref` is a vault reference; no secret ever sits in a column.
- `nodes` gained `endpoint_host` (node-port seam, conceptually removed by phase 4).

## Decisions the plan delegated (with rationale)

1. **Setup hook convention: executable `.t3env/setup.sh` at the repo root**, run from the
   workspace on **every container boot** (not just first create). Rationale: apt installs and
   other root-fs state are lost on recreate, and the entrypoint cannot tell "recreate" from
   "restart" — so the hook must be idempotent and always run. A present-but-not-executable hook
   logs a warning and is skipped; a failing hook aborts the boot loudly (a half-prepared
   environment must not serve). Documented in `fleet/image/README.md`.
2. **age library: `age-encryption` (typage, FiloSottile's TypeScript implementation)** — pure JS
   (noble crypto), no native builds, X25519 identities compatible with the `age` CLI. Identity at
   `<dataDir>/vault/identity` (0600, generated on first start); payloads in one
   `<dataDir>/vault/secrets.json` keyed by ref (per `architecture.md` §3 "the secrets file"),
   values base64(age ciphertext), file mode 0600, atomic tmp+rename writes serialized by a
   semaphore.
3. **Endpoint host mechanism**: the agent hello carries an optional `endpointHost`
   (`FLEET_AGENT_ADVERTISE_HOST`); the controller falls back to the WS connection's remote
   address (IPv4-mapped IPv6 normalized). Persisted per node (`nodes.endpoint_host`), consumed
   only by `EnvironmentEndpoints.nodePortEndpoint` — the single function phase 4 replaces with
   tailnet URLs. `PROTOCOL_VERSION` stays 1 (optional, additive field; no mixed deployments).
4. **Create step model**: persisted `create_step` enum
   `scheduled → image-ready → created → started → healthy → session-issued → ready`, side effect
   first, then the step is recorded. Every arm is re-runnable: driver create/start are idempotent
   (phase 2), health is a read, and session issue first revokes stale `fleet-controller`-labeled
   sessions via `t3 auth session list --json` + `revoke` (a crash between issue and persist
   cannot accumulate sessions). Startup reconciliation re-drives rows whose desired and observed
   state disagree, waiting up to 5 minutes for the node's agent to reconnect. Failed creates
   (observed `error`, desired `running`) are **not** auto-retried — operator destroys or
   investigates; failed destroys are retried on every controller start (destroy converges).
5. **One runner fiber per environment** (create or destroy), tracked in the `Environments`
   service; a destroy interrupts an in-flight create. This is the serialization phase 7's
   suspend/update flows should reuse.
6. **Admin session TTL: 365d** (`t3 auth session issue --ttl 365d --label fleet-controller`).
   Upstream's default is 30 days — too short for long-lived environments. Renewal/rotation is
   deliberately left to a later phase (flagged here; phase 7's poller would be the natural owner).
7. **`pullImage` local fallback**: a failed `docker pull` is tolerated when the image exists
   locally (locally built images are never pullable; a down registry must not block creates on
   nodes with the image cached). Digest reporting unchanged.
8. **Destroy archive**: exec `git add -A -N && git diff HEAD` in `/root/workspace`, gzipped to
   `<dataDir>/archives/<envId>-<millis>.patch.gz`. Patch-based (text over the WS exec channel),
   includes untracked files via intent-to-add, skipped when empty, best-effort (never blocks
   destroy). Exec is used exactly twice overall — session bootstrap and this archive — everything
   else is HTTP, per `architecture.md` §2.
9. **Activity shape** (`EnvironmentActivity`): threadCount, runningTurnCount (threads whose
   `latestTurn.state === "running"`), lastThreadUpdatedAt, snapshotUpdatedAt. Persisted as
   `activity_json` on every successful poll; an unreachable poll keeps the last known activity.
   Phase 7's idle predicate can combine `runningTurnCount == 0` with the timestamps and
   `last_status_at`. Terminal attachment is not visible in the snapshot — see notes to phase 7.

## HTTP API additions

| Endpoint                                  | Behavior                                                             |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/environments`                   | `EnvironmentSummary[]` (from `@t3fleet/shared/environment`)          |
| `POST /api/environments`                  | `{gitUrl, gitBranch?, nodeId?, name?}` → summary immediately; async  |
| `GET /api/environments/:id`               | summary incl. `createStep`, `observedState`, `endpointUrl`, activity |
| `POST /api/environments/:id/pairing-link` | `{url, expiresAt}` — one-time, never stored (409 not-ready, 502)     |
| `POST /api/environments/:id/destroy`      | `{archive?}` → summary; destroy runs async                           |

## Security paths (all automated-tested)

- Session tokens: encrypted at rest via the vault; `Vault.test.ts` proves round-trip, 0600 modes,
  restart persistence, **no plaintext anywhere under dataDir**, and that the secrets file alone
  (without the identity) cannot be decrypted. `Environments.test.ts` re-scans the whole dataDir
  (including the SQLite file) for the bearer token after a full create.
- Pairing links: minted with the vault-stored admin session (the fake T3 asserts the exact bearer
  token), event log records the mint without the credential, and the credential appears in no
  controller file. Unauthorized mint (revoked session) surfaces as a typed 502-mapped error.
- Session issue output is never logged (a parse failure deliberately drops the raw output since
  it contains the token); exec error messages carry stderr only.

## Tests added (18 new; 53 total, plus the docker integration test — all green)

- `controller/src/vault/Vault.test.ts` — 4 tests (see above).
- `controller/src/environments/Scheduler.test.ts` — 6 placement tests (bin-packing, explicit
  node, disconnected/unknown rejection, capacity-less nodes, empty pool).
- `controller/src/environments/Environments.test.ts` — 6 wire-level tests with the real agent +
  FakeDriver + a fake T3 HTTP server + fake `t3` CLI exec: full create step machine (asserting
  the exact create spec: `T3ENV_GIT_URL`/`T3ENV_GIT_BRANCH`, port 3773 published), status
  polling/activity, no-plaintext-at-rest, pairing authorization + never-stored, destroy
  (archive/revoke/vault cleanup), **create-step reconciliation across a simulated controller
  restart** (two controller incarnations over one DB file and one driver; resumes from `created`
  and converges with exactly one session), and clean failures (no image / no node).
- `controller/src/environments/Lifecycle.docker.test.ts` — integration with real Docker (skipped
  without a daemon, like phase 2): real controller + real agent + `DockerDriver` (runc) driving
  create → status → pairing → destroy against containers running the **real `t3@0.0.29` npm
  binary** and the real entrypoint (slim `node:24` test image; the repo is served to the
  container over git's dumb HTTP protocol from a bare clone). Covers: clone + setup-hook marker,
  project registration visible in the real orchestration snapshot, distinct
  environment ids/endpoints, two same-repo environments fully independent, pairing URL shape +
  the pair page serving the web app, destroy leaving zero containers/volumes, archive written,
  vault cleaned.
- `shared/src/protocol.test.ts` — hello round-trip with `endpointHost`.

Test-authoring gotchas: lifecycle tests must be `it.live` (TestClock freezes health/poll
schedules); the fake T3 server needs `server.closeAllConnections()` in its release or teardown
hangs; `FakeDriver.makeService` (not the layer) is how you keep driver state across simulated
restarts.

## Validation performed

- `pnpm typecheck`, `pnpm lint`, `pnpm test` clean inside `fleet/` (53 tests + the docker
  integration test ran against this VM's real Docker under `runc`).
- `t3env:dev` rebuilt with the new entrypoint (`fleet/image/build.sh`).
- Manual run (controller + agent processes, `t3env:dev`, runc): created **two environments for
  `https://github.com/octocat/Hello-World.git` on one node**; both reached `ready` with distinct
  node ports; verified clone, project registration (snapshot lists `/root/workspace`), and per-env
  descriptor identity; minted pairing links via the API and exercised them exactly as the browser
  does (`POST /api/auth/browser-session` with the token from the URL → authenticated cookie
  session with standard client scopes; web UI serves HTML at `/pair`; token reuse rejected 401);
  verified independence (file written in A's workspace absent from B; separate volumes); destroyed
  both (one with archive) — zero containers, zero volumes, vault `secrets.json` back to `{}`, and
  the archive gunzips to exactly the uncommitted file. Processes and temp state removed after.
- **Not verifiable in this environment** (pending real hardware / a browser):
  1. Everything sysbox-specific (unchanged from phase 2's list; this phase ran under `runc` with
     the inner dockerd warning path).
  2. A real click-through of the pairing URL in a graphical browser (this VM has no browser
     automation host). The equivalent HTTP exchange the `/pair` page performs was verified
     manually end to end; open a minted link in a browser during phase 4/6 validation.

## Notes to later phases

- **Phase 4 (tailnet)**: the endpoint seam is `environments/EnvironmentEndpoints.ts` — replace
  `nodePortEndpoint` with the MagicDNS HTTPS URL and delete: `publishPorts` in
  `Environments.stepCreated`, the host-port lookup in `stepStarted`, `endpointHost` in the hello
  frame + `advertiseHost` agent config, `nodes.endpoint_host`, and `stripPort` in
  `AgentSocket.ts`. Everything else consumes the persisted `endpoint_url`. Add your tailnet-join
  step to the create machine (a new step between `image-ready` and `created` for key minting fits
  the model) and device deletion to `runDestroy`. The entrypoint's bootstrap order comment marks
  where tailscaled goes.
- **Phase 5 (vault)**: extend `controller/src/vault/Vault.ts` into the full profile/secret model —
  it is deliberately minimal (store/read/delete, one secrets file). Keep its tests. Credential
  materialization slots into the entrypoint before the clone (marked); the clone currently
  supports only unauthenticated/embedded-credential URLs — wire your git-credential path into it.
- **Phase 6 (dashboard)**: `GET /api/environments` returns `EnvironmentSummary` from
  `@t3fleet/shared/environment`; "open chat" = `POST /api/environments/:id/pairing-link` then
  navigate to `url`. Create is async — poll `createStep`/`observedState` (values in the shared
  schema); `error` carries a human-readable message. The events log now has kinds:
  `environment-create-requested/-ready/-create-failed/-status-changed/-destroy-requested/
-destroyed/-destroy-failed`, `pairing-link-minted`.
- **Phase 7 (policies/updates)**: idle inputs are `activity_json` + `last_status_at`
  (`EnvironmentActivity`; poll cadence `FLEET_CONTROLLER_STATUS_POLL_INTERVAL_MS`, default 15s).
  Caveat: attached terminals are **not** visible in the orchestration snapshot — if the idle
  predicate must honor them, check `GET /api/auth/clients` (`connected` flag) with the stored
  session, or accept turn-based idleness. Reuse the `Environments` runner map for suspend/update
  serialization (destroy-interrupts-create already works this way). The admin session TTL is 365d
  — consider re-issuing during long-lived polling (decision 6). For image updates, remember
  destroy removes volumes — you need the container-only recreate noted in the phase-2 handoff.
- **Phase 8 (packaging)**: new controller env vars `FLEET_CONTROLLER_STATUS_POLL_INTERVAL_MS`,
  `FLEET_CONTROLLER_ENVIRONMENT_HEALTH_TIMEOUT_MS`; agent `FLEET_AGENT_ADVERTISE_HOST` (dies with
  phase 4). Controller backup now includes `dataDir/vault/` (identity + secrets) and
  `dataDir/archives/` alongside the SQLite file — the spec's "SQLite + age identity" story holds,
  with archives as optional extras.
