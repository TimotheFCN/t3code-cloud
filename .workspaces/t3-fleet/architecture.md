# Architecture — Implementation Decisions

The system design is the approved spec at `docs/fleet/architecture.md`; read it first and treat it
as authoritative for topology, networking, lifecycle, durability, vault behavior, security, and
scope. This document adds the implementation-level decisions so eight agents do not re-decide them
eight times. Decisions here were made deliberately; phases must follow them unless their handoff
documents a justified deviation. §7 lists what is still open and who decides.

## 1. Where Fleet lives and how it is built

- Fleet is a **standalone top-level `fleet/` directory** in this fork with its **own pnpm
  workspace and its own lockfile**. It is _not_ added to the root `pnpm-workspace.yaml` and it
  does not import `@t3tools/*` workspace packages. Rationale: the root lockfile is the highest
  merge-conflict surface against upstream; Fleet consumes T3 through the CLI and HTTP APIs only,
  and a hard package boundary enforces the low-drift policy mechanically.
- Layout inside `fleet/` (indicative — phase 1 finalizes):

  ```text
  fleet/
  ├── package.json / pnpm-workspace.yaml / pnpm-lock.yaml
  ├── packages/
  │   ├── controller/     # control plane service (API, scheduler, vault, tailnet integration)
  │   ├── agent/          # per-node daemon (docker driver, exec proxy, credsync endpoint)
  │   ├── dashboard/      # React + Vite management UI, served by the controller
  │   └── shared/         # protocol schemas shared by controller/agent/dashboard
  ├── image/              # t3env Dockerfile, entrypoint, credsync helper, build script
  └── deploy/             # controller docker-compose.yml, join.sh, ACL examples, operator docs
  ```

- Stack: **TypeScript + Effect** (matching fork conventions; read `.repos/effect-smol/LLMS.md`
  first), Node 24. Dashboard: React + Vite. Effect is a normal npm dependency inside `fleet/`, not
  a workspace link.
- Tooling inside `fleet/` may use plain `pnpm` + `vitest` + `tsc`; do not couple Fleet's build to
  the root `vp` config. Keep commands documented in `fleet/README.md`.

## 2. Component boundaries and protocol

- **Controller** is the only stateful service: SQLite (via `node:sqlite` or `better-sqlite3` —
  implementation may decide) + `age`-encrypted secrets file. It exposes:
  - an HTTP API + the dashboard (one port, tailnet-only),
  - a WebSocket endpoint for agents.
- **Agent ↔ controller protocol**: JSON messages over one outbound WebSocket from the agent,
  schema-validated on both sides from `fleet/packages/shared`. Requests are controller→agent
  commands (pull, create, start, stop, destroy, exec, snapshot-volume, stat) with correlation ids;
  agent→controller streams are events (status, logs, stats, credsync reports). Version the
  protocol from day one (a `protocolVersion` field checked at join).
- **Driver interface** (in the agent): `createEnvironment`, `startEnvironment`,
  `stopEnvironment`, `destroyEnvironment`, `execInEnvironment`, `snapshotVolume`,
  `listEnvironments`. Only the `docker` driver is implemented; the interface exists so the
  controller model never references Docker concepts directly.
- **Environment bootstrap order** (entrypoint, sequential): tailscaled up + tailnet join →
  credential materialization → workspace clone → setup hook → `t3 project add` → `t3 serve
--tailscale-serve`. Bootstrap credential issuance (`t3 auth session issue --json`) runs as a
  controller-driven `exec` after the server is healthy.
- **After bootstrap, the controller talks to environments over HTTP only**: status via
  `GET /.well-known/t3/environment` + `GET /api/orchestration/snapshot`, pairing links via
  `POST /api/auth/pairing-token` with its stored admin session. `exec` is reserved for bootstrap
  and break-glass operations.

## 3. Data model (controller SQLite)

| Table          | Key fields (indicative)                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodes`        | id, name, join state, agent credential hash, last-seen, capacity snapshot, protocol version                                                                                                                                  |
| `environments` | id, name (`env-<id>`), node id, project git URL + branch, image digest, credential profile id, desired state (running/suspended/destroyed), observed state, tailnet device id, T3 admin-session (vault ref), created/updated |
| `images`       | tag, digest, provider CLI versions, "current" flag                                                                                                                                                                           |
| `profiles`     | id, name, secret refs                                                                                                                                                                                                        |
| `secrets`      | id, kind (`env-var` / `file-bundle` / `git`), name, encrypted payload ref, updated-at, credsync fingerprint                                                                                                                  |
| `join_tokens`  | token hash, single-use flag, expiry                                                                                                                                                                                          |
| `events`       | append-only operational log (create/destroy/wake/update/credsync), for the dashboard activity view                                                                                                                           |

Encrypted payloads live in the secrets file keyed by ref, not in SQLite rows; the DB stores
references and metadata only. Migrations: plain ordered SQL files applied at controller start
(forward-only, mirroring upstream's convention).

## 4. Security invariants (every phase must preserve)

1. Secrets are never written to logs, never stored plaintext at rest, and travel
   controller→agent→container sealed to the receiving agent's key.
2. The controller's per-environment T3 session tokens are secrets (stored via the vault, not as
   plaintext DB columns).
3. Environments are untrusted: nothing an environment can reach (its own T3 API, credsync
   endpoint) may mutate controller state beyond its own credsync reports and status.
4. The dashboard/API binds to the tailnet interface only; tailnet ACLs are the access control for
   v1 (see §7 Q3). Join tokens are single-use and expire.
5. Pairing links are minted on demand, once per click, with the default TTL — never stored.

## 5. Schema-change map (indicative — each phase generates its own migrations)

| Phase | Controller schema touched                                      |
| ----- | -------------------------------------------------------------- |
| 01    | `nodes`, `join_tokens`, `events` (initial migration)           |
| 02    | `images`; `environments` (container/volume columns)            |
| 03    | `environments` (T3 session ref, observed state, project cols)  |
| 04    | `environments` (tailnet device id); tailnet config in settings |
| 05    | `profiles`, `secrets`; credsync fingerprints                   |
| 06    | none expected (dashboard reads existing state)                 |
| 07    | `environments` (idle policy, snapshot metadata)                |
| 08    | none expected (packaging)                                      |

## 6. Journey coverage (sanity map)

| Journey / edge case                                                           | Covered by |
| ----------------------------------------------------------------------------- | ---------- |
| Operator installs controller on a homelab box                                 | 08         |
| Operator adds a node with the join script (fresh Ubuntu box)                  | 01, 08     |
| Create an environment for a project (clone, register, serve)                  | 02, 03     |
| Environment reachable at `https://env-<id>.<tailnet>.ts.net/`                 | 04         |
| Open a chat from the dashboard in one click (pairing link)                    | 03, 06     |
| Two environments for the same project run independently (e.g. two Supabase)   | 02, 03     |
| Agent inside an environment runs `docker`/`supabase start`                    | 02         |
| Central API keys / provider OAuth bundles injected per environment            | 05         |
| Provider CLI rotates a token; vault copy stays usable                         | 05         |
| Update base image; Supabase data + workspace + pairing survive                | 07         |
| Roll back a bad image update (pre-update snapshot)                            | 07         |
| Idle environment suspends; wake from dashboard; clients reconnect             | 07         |
| Destroy an environment (volume gone, tailnet device deleted, session revoked) | 03, 04     |
| Node goes offline; dashboard shows unreachable; other nodes unaffected        | 01, 06     |
| Controller restore from backup (SQLite + age identity)                        | 01, 08     |

## 7. Open questions

**Product decisions (owner must confirm; recommended defaults in bold):**

1. Dashboard authentication for v1 — **rely on tailnet ACLs only (no separate login)**; a reverse
   proxy with auth can be layered by operators who want it. Alternative: a single operator
   password.
2. Image distribution — **bring-your-own OCI registry** (documented recipes for `registry:2` as a
   compose sidecar and ghcr private packages). Alternative: stream images node-to-node via
   `docker save/load` through the agent channel (registry-less, more code).
3. Base image provider CLI set — **all four upstream-supported CLIs (codex, claude-code,
   cursor-agent, opencode)** pinned in the Dockerfile.
4. Single-box mode (controller + agent on the same machine) — **supported and documented as the
   default starter topology**.

**Decided (see `docs/fleet/architecture.md` and §1–§5 above):** standalone `fleet/` workspace;
TypeScript + Effect; Tailscale-everywhere networking with per-environment devices; no relay
contract; volume durability contract; PAT/file-bundle git credentials in v1; join-script-only node
provisioning; no phased product rollout (phases are execution units).

**Implementation may decide (record in handoff):** SQLite driver; WS message envelope details;
dockerode vs Docker CLI shelling; `age` library vs `rage` binary; dashboard component library;
credsync watch mechanism (inotify vs polling); exact volume mount layout inside the container;
how `join.sh` installs sysbox per distro.
