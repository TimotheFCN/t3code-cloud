# Phase 2 Handoff — Docker Driver and Base Image

Phase 2 is shipped and validated (with the sysbox-specific items pending real hardware, listed
below). A node can now create, start, stop, destroy, exec into, and snapshot/restore environment
containers built from the reproducible `t3env` image, and the controller has an image registry
with pull orchestration.

## What changed

```text
fleet/
├── image/                                  # NEW — the t3env base image
│   ├── Dockerfile                          # ubuntu:24.04, every version an explicit ARG
│   ├── daemon.json                         # inner dockerd data-root -> /root/.docker-data
│   ├── entrypoint.sh                       # start dockerd (best effort) + t3 serve
│   ├── build.sh                            # build + optional push (REGISTRY/TAG/PUSH env)
│   └── README.md                           # volume layout / durability contract, build docs
└── packages/
    ├── shared/src/
    │   ├── environment.ts                  # extended: CreateEnvironmentSpec, ExecResult,
    │   │                                   #   VolumeSnapshot, PulledImage, PortBinding,
    │   │                                   #   descriptor grew containerId/volumeName/ports
    │   ├── image.ts                        # NEW — ImageSummary, ImagePullResult
    │   └── protocol.ts                     # 7 new req types + payloads, ControllerRequestBody
    ├── agent/src/
    │   ├── Config.ts                       # + dockerRuntime, snapshotRetention, helperImage
    │   ├── Connection.ts                   # handles all driver request types (respondDriver)
    │   ├── main.ts                         # DockerDriver wired in (FakeDriver was placeholder)
    │   └── driver/
    │       ├── Driver.ts                   # + pullImage, restoreVolume; snapshotVolume owns paths
    │       ├── DockerDriver.ts             # NEW — the production driver (docker CLI)
    │       └── FakeDriver.ts               # updated to the same contract
    └── controller/src/
        ├── Controller.ts                   # Images/ImagePulls in Services composition
        ├── db/migrations/002_images.sql    # NEW
        ├── images/Images.ts                # NEW — registry service
        ├── images/ImagePulls.ts            # NEW — pull orchestration through agents
        ├── http/Api.ts                     # /api/images endpoints
        └── nodes/AgentConnections.ts       # request() takes typed body + per-request timeout
```

`fleet/README.md` documents the new config keys, driver behavior, and API routes.

## Decisions the plan delegated (with rationale)

1. **Docker access: shell out to the `docker` CLI**, not dockerode. Runs through
   `effect/unstable/process/ChildProcess` + `NodeChildProcessSpawner` (already in the pinned
   Effect beta — zero new dependencies), parses `--format '{{json .}}'` / `inspect` JSON with
   Schema. This avoids dockerode's transitive deps and the exec stream-multiplexing code; the CLI
   is a node prerequisite anyway. If a future phase needs streamed logs/events, revisit — the
   spawner also supports streaming.
2. **Volume layout: one named volume `t3env-<id>-home` mounted at `/root`** (container user is
   root; sysbox maps it to an unprivileged host uid). Inside it: `T3CODE_HOME=/root/.t3`, inner
   Docker `data-root=/root/.docker-data` (via the image's `/etc/docker/daemon.json`),
   `/root/workspace` (phase 3), `/root/.tailscale` (phase 4). A named volume is a real host
   filesystem, so inner overlayfs works there and sysbox's special `/var/lib/docker` handling is
   not involved. **Consequence baked into the image**: every binary installs to `/usr/local`,
   never `/root` — Docker seeds a fresh volume from the image's `/root` and the volume then
   persists, so anything under `/root` in the image would go stale after image updates.
3. **Sysbox absent → hard failure.** The runtime name is agent config
   (`FLEET_AGENT_DOCKER_RUNTIME`, default `sysbox-runc`). `createEnvironment` checks
   `docker info` runtimes and fails with a diagnostic naming the runtime and pointing at sysbox
   installation. There is no privileged fallback anywhere; tests/dev set `runc` explicitly
   (documented as unsupported for production).
4. **Reconciliation over bookkeeping.** The driver holds zero in-memory state. Containers and
   volumes carry labels (`t3fleet.managed=true`, `t3fleet.environment-id`,
   `t3fleet.environment-name`, `t3fleet.volume-name`); every read (`listEnvironments`,
   `findContainer`) derives from `docker ps -a --filter label=...` + `inspect`. Agent restart
   re-adopts everything by construction (covered by a test). `createEnvironment` is idempotent
   per id — a retried create adopts the existing container; `destroyEnvironment` removes
   whatever half exists (container and/or volume) and converges on retry.
5. **Interface extensions beyond the phase-1 seam** (recorded, deliberate):
   - `pullImage(reference)` — the agent must pull; architecture §2 lists `pull` as a protocol
     command even though the phase-1 interface omitted it.
   - `restoreVolume(environmentId, snapshotPath)` — phase 7 rollback needs it and the phase-2
     validation demands a snapshot/restore round-trip. Restore requires the environment stopped.
   - `snapshotVolume(environmentId)` now owns path + retention (tarballs under
     `<stateDir>/snapshots/<envId>/<millis>.tar.gz`, newest `snapshotRetention` kept, default 5).
     Snapshot/restore run a helper container (`helperImage`, default `alpine:3.22`) that tars the
     volume; snapshots of running environments are crash-consistent — phase 7 should stop first.
6. **No `environments` table yet.** The §5 schema map lists `environments` under phase 2, but
   nothing controller-side would write it in this phase; creating dead schema violates the
   cleanup rule. Phase 3 owns that migration (`003_*.sql`) and knows what columns its
   create-steps model needs.
7. **`t3env` port**: the image defaults to upstream's `T3CODE_PORT` default `3773`
   (`T3CODE_HOST=0.0.0.0`, `T3CODE_HOME=/root/.t3`, `T3CODE_NO_BROWSER=1`). The controller
   overrides per environment via `CreateEnvironmentSpec.env` and maps ports via `publishPorts`
   (omit `hostPort` for an ephemeral one; the resolved port appears in
   `EnvironmentDescriptor.ports` while running).

## Schema (migration `002_images.sql`)

`images(id, reference UNIQUE, digest, is_current, created_at, updated_at)` with a partial unique
index enforcing at most one `is_current = 1` row. The first registered image becomes current
automatically; `setCurrent` moves the flag transactionally; the digest is recorded from the first
successful node pull.

## Protocol additions

New `req` types (all handled in `agent/src/Connection.ts`, payload schemas in
`shared/src/protocol.ts`): `pull-image`, `create-environment`, `start-environment`,
`stop-environment`, `destroy-environment`, `exec-environment`, `snapshot-volume`. Error codes on
`res`: `driver-error`, `environment-not-found`. `AgentConnections.request(nodeId, body, options?)`
now takes the typed request body (`ControllerRequestBody`) and an optional per-request `timeout`
(default stays 10s; `ImagePulls` uses 10 minutes). `PROTOCOL_VERSION` stays 1 — nothing existing
changed shape, and no mixed-version deployments exist yet.

## The t3env image

Pinned in this commit: Node `24.13.1`, `t3@0.0.29`, `@openai/codex@0.145.0`,
`@anthropic-ai/claude-code@2.1.220`, `opencode-ai@1.18.8`, cursor-agent `2026.07.23-e383d2b`
(versioned tarball from `downloads.cursor.com/lab/...` — same URL the official installer uses),
tailscale `1.98.9` (static tarball; joined in phase 4), gh `2.96.0`, Docker Engine apt pins
`5:29.6.2-1~ubuntu.24.04~noble` (+ containerd `2.2.6`, buildx `0.35.0`, compose `5.3.1`), on
`ubuntu:24.04`. `python3` is included because `t3`'s `node-pty` dependency compiles via node-gyp
at install time. Multi-arch-ready (amd64/arm64 via `dpkg --print-architecture` mapping) but only
amd64 was built and validated.

The entrypoint is phase-2 minimal: start inner `dockerd` (up to 30s wait; on plain runc it warns
and continues so the T3 server still runs), then `t3 serve` from `T3CODE_*` env.
`T3ENV_SKIP_DOCKERD=1` skips the daemon. Build with `fleet/image/build.sh`
(`REGISTRY`/`TAG`/`PUSH`/`BUILD_ARGS`); no secrets required.

## Tests added (13 new, 36 total, all green)

- `agent/src/driver/DockerDriver.test.ts` — against real local Docker, **skipped automatically
  when no daemon is available**; uses runtime `runc` and a tiny `alpine`-based test image:
  - full lifecycle (labels, env-var injection, published-port resolution, volume existence,
    destroy leaves nothing),
  - **reconciliation**: a fresh driver layer ("restarted agent") adopts labeled containers,
    ignores unlabeled ones, re-adopts on duplicate create, and keeps operating the adopted
    environment,
  - exec round-trip (stdout/stderr separation, non-zero exit codes; exec on stopped = error),
  - snapshot → mutate → restore round-trip plus retention pruning; restore-while-running refused,
  - missing-runtime diagnostic (asserts the sysbox message; no fallback),
  - unknown-environment errors and idempotent destroy of an orphaned volume,
  - pull + digest reporting.
- `controller/src/images/Images.test.ts` — register/first-becomes-current, duplicate reference
  rejection, atomic current-flag move, digest recording, unknown-id errors.
- `controller/src/http/AgentSocket.test.ts` — new wire-level test: create/start/exec/destroy +
  typed `environment-not-found` error + register/pull with digest recording, through the real
  request/response machinery (FakeDriver behind the agent).
- `shared/src/protocol.test.ts` — round-trips for all new frames.
- Updated: `FakeDriver.test.ts` (new contract incl. adopt-on-create and restore rules),
  `Migrator.test.ts` (images table, count-agnostic idempotency).

Gotcha for test authors: driver tests must be `it.live`, not `it.effect` — `it.effect` runs under
the TestClock, so `Clock.currentTimeMillis` is frozen at 0 and snapshot filenames collide.

## Validation performed

- `pnpm typecheck`, `pnpm lint`, `pnpm test` clean inside `fleet/` (driver tests ran against this
  VM's real Docker 29.6.2).
- Image build succeeds from scratch with no secrets (`./build.sh` → `t3env:dev`).
- All pinned CLIs verified inside the image at exactly their pinned versions (`t3`, `codex`,
  `claude`, `opencode`, `cursor-agent`, `tailscale`/`tailscaled`, `docker`/`dockerd`/compose/
  buildx, `gh`, `node`, `git`, `rg`, `gcc`).
- Manual run under plain `runc`: `t3 serve` starts, serves its web UI (HTTP 200) and
  `/.well-known/t3/environment` (serverVersion 0.0.29) on the mapped port, prints a pairing URL;
  entrypoint logs the expected dockerd warning; volume persists a marker file and `T3CODE_HOME`
  across stop/start.
- Inner Docker path validated via a **manually run** `--privileged` container (validation
  shortcut only — the driver never uses privileged): inner dockerd ready, `docker run
hello-world` succeeds, a compose stack (nginx) comes up and serves HTTP inside the environment,
  data-root confirmed at `/root/.docker-data`, and after a container **recreate** against the
  same volume the inner images and workspace files are still there (the image-update durability
  contract, minus sysbox).

### Pending on real hardware (this VM has no sysbox and no `/dev/kvm`)

1. `createEnvironment` under actual `--runtime=sysbox-runc` (the driver flag itself).
2. Inner dockerd + hello-world + compose inside a sysbox container (validated here only under
   manual `--privileged`).
3. uid-shifting behavior of the `/root` volume under sysbox (file ownership across
   create/destroy/snapshot) — expected fine (sysbox idmaps volume mounts), unverified.
4. `tailscaled` runs only in phase 4; only `tailscale version` was exercised.

Everything else in this phase's validation section was verified here.

## Notes to later phases

- **Phase 3 (lifecycle)**: `CreateEnvironmentSpec.env` + `publishPorts` are your hooks — set
  `T3CODE_*` per environment and read the resolved `hostPort` from the running descriptor
  (`EnvironmentDescriptor.ports`); that is the node-port access path phase 4 replaces. Use
  `Images.current` for the create-time reference and pull via `ImagePulls` (or directly with a
  generous `timeout` on `AgentConnections.request`) before create. Exec over the wire is
  `exec-environment` (bootstrap/break-glass only). Your `environments` migration is `003_*.sql`
  — see decision 6. Expect create→ready to take seconds (image present) — the container is
  `created`, you must `start-environment` explicitly.
- **Phase 4 (tailnet)**: put tailscaled state in `/root/.tailscale` (on the volume — stable
  device identity); the binaries are already in the image. Extend the entrypoint's bootstrap
  order per architecture §2 and delete phase 3's `publishPorts` usage when tailnet URLs land.
- **Phase 5 (vault)**: file bundles materialize under `/root` (`.claude`, `.codex`, `.cursor`,
  `.config/gh`) — all on the volume. Env-var secrets ride `CreateEnvironmentSpec.env` today;
  that path is **not sealed** yet (values transit the controller→agent WS in cleartext JSON over
  the tailnet) — your sealed-payload design replaces it; do not put long-lived secrets in `env`
  before then.
- **Phase 7 (updates/policies)**: recreate-on-update = `stop` → `snapshot-volume` → `destroy`
  … but note destroy removes the volume! For image updates you want container-only removal +
  recreate with the same volume; either add a driver operation for "recreate container keeping
  volume" or extend `destroyEnvironment` with a keep-volume option — the volume/label plumbing
  already supports it. `restoreVolume` is your rollback primitive; retention default is 5 per
  environment (`FLEET_AGENT_SNAPSHOT_RETENTION`).
- **Phase 8 (join script)**: nodes need Docker Engine + sysbox-runc + the `docker` CLI on the
  agent's PATH (the agent shells out). The agent's snapshots dir lives under
  `FLEET_AGENT_STATE_DIR` — mount it persistently. `alpine:3.22` (helper) must be pullable, or
  set `FLEET_AGENT_HELPER_IMAGE` to a mirror.
