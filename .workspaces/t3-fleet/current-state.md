# Current-State Analysis

Factual map of the existing systems T3 Fleet builds on. Verified against the t3code repository on
the `fleet/architecture-spec` branch (July 2026). File paths are relative to the repository root.
Always re-verify details before building on them — this document orients, it does not replace
exploration.

## 1. Repository and toolchain

- pnpm monorepo managed by the `vp` (Vite+) CLI: `vp i`, `vp check --fix`, `vp run typecheck`,
  `vp test run <files>`. A pre-commit hook runs `vp fmt` on staged files.
- Workspaces: `apps/{server,web,desktop,mobile,marketing}`, `packages/{contracts,shared,
client-runtime,ssh,tailscale,effect-acp,effect-codex-app-server}`, `infra/relay`,
  `oxlint-plugin-t3code` (see `pnpm-workspace.yaml`).
- Language/stack: TypeScript + Effect throughout. `AGENTS.md` mandates reading
  `.repos/effect-smol/LLMS.md` before writing Effect code and inspecting `.repos/effect-smol/` for
  idiomatic patterns. Node requirement for the server package: `^22.16 || ^23.11 || >=24.10`
  (`docs/user/remote-access.md`); this VM runs Node 24.
- `AGENTS.md` scopes local verification: run focused tests only, never repo-wide suites; backend
  changes must include focused tests.

## 2. The T3 server as an execution environment

- One running T3 server = one `ExecutionEnvironment` — upstream's own execution boundary,
  documented in `docs/architecture/remote.md`. Clients reach it over plain HTTP/WebSocket.
- Published as the npm package `t3` with bin `t3` (`apps/server/package.json`, currently v0.0.29).
- `t3 serve` runs the server headless (no browser open) and prints pairing details; `t3 start` is
  the browser-opening variant (`apps/server/src/cli/server.ts`).
- Server configuration via env vars (`apps/server/src/cli/config.ts`): `T3CODE_HOST`,
  `T3CODE_PORT`, `T3CODE_HOME` (state directory), `T3CODE_NO_BROWSER`, `T3CODE_MODE`,
  `T3CODE_LOG_LEVEL`, `T3CODE_TAILSCALE_SERVE`, `T3CODE_TAILSCALE_SERVE_PORT`, and others. All
  flags have env equivalents.
- The server serves the built React web app itself — a paired browser needs no separate hosted web
  app (`AGENTS.md` package roles; `apps/server` "serves the React web app").
- Server state (SQLite, auth, projects) lives under `T3CODE_HOME` (default `~/.t3`). Migrations
  are forward-only; migration `031_AuthAuthorizationScopes` was a hard cutover
  (`docs/cloud/environment-auth.md` §Upgrade Behavior).
- Provider CLIs (`codex`, `claude`, `cursor-agent`, `opencode`) are external binaries probed on
  `PATH` at startup and re-probed roughly every 5 minutes. The server forwards `process.env` to
  provider child processes, so API keys injected as env vars reach the CLIs
  (`.cursor/rules/cursor-cloud.mdc`, `apps/server/src/provider/`).

## 3. Environment authentication

Documented in `docs/cloud/environment-auth.md`; implementation in `apps/server/src/auth/`.

- Capability-based scopes: `orchestration:read`, `orchestration:operate`, `terminal:operate`,
  `review:write`, `access:read`, `access:write`, `relay:read`, `relay:write`.
- Ordinary pairing links grant the four client scopes + `relay:read`. Administrative credentials
  additionally grant `access:read access:write relay:write`.
- CLI credential management (`apps/server/src/cli/auth.ts`):
  - `t3 auth pairing create [--ttl] [--label] [--base-url] [--json]` issues a one-time pairing
    token; with `--base-url` it prints a ready `<base-url>/pair#token=...` link. Grants standard
    client scopes.
  - `t3 auth session issue [--ttl] [--label] [--subject] [--token-only] [--json]` issues a bearer
    session with **administrative** scopes (`AuthAdministrativeScopes`) — this is how an external
    controller obtains a long-lived admin session.
  - `t3 auth pairing list/revoke`, `t3 auth session list/revoke` for lifecycle.
  - These commands operate directly on the auth database under the configured data dir (they take
    location flags), so they can be run via `exec` inside a container running the server.
- HTTP auth API (`packages/contracts/src/environmentHttp.ts`, lines ~375–450):
  - `GET /.well-known/t3/environment` — environment descriptor (id, label, version).
  - `POST /oauth/token` — RFC 8693-shaped token exchange: bootstrap credential → bearer session.
  - `POST /api/auth/browser-session` — bootstrap credential → browser cookie session.
  - `POST /api/auth/websocket-ticket` — any session → short-lived WS ticket.
  - `POST /api/auth/pairing-token` — **mint a pairing credential over HTTP** (requires
    `access:write`). An admin session can therefore create pairing links remotely; no exec needed
    after bootstrap.
  - `GET /api/auth/pairing-links`, `POST /api/auth/pairing-links/revoke`, `GET /api/auth/clients`,
    `POST /api/auth/clients/revoke` — credential/session inventory.
- Pairing URL format: `<origin>/pair#token=<credential>` — token in the URL hash.

## 4. Environment HTTP surface useful for orchestration

From `packages/contracts/src/environmentHttp.ts`:

- `GET /api/orchestration/snapshot` — full orchestration snapshot (requires
  `orchestration:read`). Suitable for health/activity polling.
- `GET /api/orchestration/threads/:threadId`, `POST /api/orchestration/dispatch` — thread state
  and operations (not needed by Fleet's control plane, but confirms the read/operate split).
- The descriptor endpoint (§3) is unauthenticated environment identity — suitable for liveness
  checks.

## 5. Project management

- `t3 project add <path>`, `t3 project remove`, `t3 project rename`
  (`apps/server/src/cli/project.ts`). The GUIs do not support adding projects on remote
  environments; the CLI is the documented path (`docs/user/remote-access.md`).

## 6. Tailscale support in upstream

- `t3 serve --tailscale-serve [--tailscale-serve-port N]`: the server asks Tailscale Serve to
  proxy HTTPS (default port 443) to the local backend and advertises
  `https://<machine>.<tailnet>.ts.net/` (`docs/user/remote-access.md`). Env equivalents:
  `T3CODE_TAILSCALE_SERVE`, `T3CODE_TAILSCALE_SERVE_PORT`.
- `packages/tailscale` (`@t3tools/tailscale`): Effect wrappers around the local `tailscale` CLI,
  used by the desktop endpoint provider. Private workspace package.
- Clients treat Tailscale endpoints as first-class advertised endpoints
  (`docs/architecture/remote.md` §Endpoint providers).
- Requires `tailscaled` + `tailscale` CLI available where the server runs. Nothing in upstream
  manages tailnet device lifecycle (auth keys, device deletion) — that is Fleet's job.

## 7. T3 Connect (relay) — adjacent, not used by Fleet

- The hosted control plane for public-internet discovery lives at `infra/relay` (Cloudflare
  Worker + PlanetScale + Clerk). Client contract: `packages/contracts/src/relay.ts`; client
  consumption: `packages/client-runtime/src/relay/{discovery,managedRelay}.ts`.
- The architecture spec records the decision **not** to implement the relay contract in Fleet
  (Clerk-based client auth is a poor homelab fit). Listed here so agents do not conflate the two.

## 8. Client-side environment model (relevant to the deferred directory patch)

- `packages/client-runtime/src/environment/knownEnvironment.ts`: `KnownEnvironment` with
  `source: "configured" | "desktop-managed" | "manual" | "window-origin"` and an
  `AccessEndpoint`-shaped target (`httpBaseUrl`, `wsBaseUrl`). Web app primary-environment
  resolution: `apps/web/src/environments/primary/target.ts`.
- Paired environments are browser-local; there is no central directory in stock clients. The
  candidate fork patch for this is deferred out of v1 (`docs/fleet/architecture.md` §Upstream
  Tracking Policy).

## 9. The approved architecture spec

- `docs/fleet/architecture.md` (committed on this branch) is the approved system design: topology,
  components, tailnet networking, lifecycle, durability contract, vault, upstream policy, security,
  failure modes, delivery scope. Read it in full before any phase.

## 10. Gaps summary (what Fleet must add — nothing below exists today)

- No `fleet/` code: no controller, no agent, no dashboard, no scheduler, no vault.
- No Dockerfile or OCI image for running the T3 server in a container; no entrypoint handling
  credential injection, cloning, `t3 project add`, or tailnet join.
- No tailnet device lifecycle management (OAuth client, auth-key minting, device deletion).
- No join script, no node inventory, no agent↔controller protocol.
- No suspend/wake, no image-update/recreate flow, no volume snapshot tooling.
- No credsync helper or credential write-back path.
- Upstream provides all primitives Fleet consumes (§2–§6); Fleet provides all orchestration.
