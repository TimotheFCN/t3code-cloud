# Phase 4 Handoff — Tailscale Networking

Phase 4 is shipped and validated to the extent this environment allows (everything except checks
that need a live tailnet — listed below as pending). Every environment is now its own tailnet
device: the controller mints tagged auth keys through the operator's Tailscale OAuth client, the
container joins as `env-<id>` with its identity on the volume, `t3 serve --tailscale-serve`
publishes HTTPS, endpoints are MagicDNS URLs, devices are deleted on destroy, and the phase-3
node-port path is gone.

## What changed

```text
fleet/
├── deploy/
│   └── tailscale.md                        # NEW — operator setup: MagicDNS+HTTPS, tags,
│                                           #   ACL policy, OAuth client scopes, plan limits
├── image/
│   ├── entrypoint.sh                       # tailnet join prepended (step 1 of bootstrap)
│   ├── entrypoint.test.ts                  # NEW — join logic vs PATH-stubbed binaries
│   └── README.md                           # entrypoint + volume docs updated
├── vitest.config.ts / tsconfig.json        # include image/**
└── packages/
    ├── shared/src/
    │   ├── environment.ts                  # steps + `tailnetDeviceId`/`statusDetail` on the
    │   │                                   #   summary; PortBinding/publishPorts/ports REMOVED
    │   └── protocol.ts                     # hello `endpointHost` REMOVED (version stays 1)
    ├── agent/src/
    │   ├── Config.ts / Connection.ts       # advertiseHost / endpointHost REMOVED
    │   └── driver/{DockerDriver,FakeDriver}.ts  # port publication/resolution REMOVED
    └── controller/src/
        ├── Config.ts                       # + tailscaleApiUrl, tsAuthKeyTtlSeconds,
        │                                   #   tailnetJoinTimeoutMillis, tailnetEndpointScheme
        ├── Controller.ts                   # Tailnet + TailnetSettings wired in
        ├── db/migrations/004_tailnet.sql   # NEW
        ├── tailnet/                        # NEW
        │   ├── TailscaleApi.ts             # typed control-API requests (pure functions)
        │   ├── Tailnet.ts                  # service: mint/find/delete + token cache
        │   ├── TailnetSettings.ts          # OAuth client via settings table + vault
        │   └── Tailnet.test.ts             # NEW
        ├── environments/
        │   ├── EnvironmentEndpoints.ts     # nodePortEndpoint → tailnetEndpoint(scheme, name)
        │   ├── Environments.ts             # steps key-minted + tailnet-joined; device delete
        │   ├── EnvironmentsRepo.ts         # tailnet columns; setEndpoint → setTailnetDevice
        │   └── {Environments,Lifecycle.docker}.test.ts  # fake Tailscale API stacks
        ├── http/Api.ts                     # GET/PUT /api/settings/tailscale; 409 on create
        └── http/AgentSocket.ts / nodes/NodeRegistry.ts  # endpoint-host recording REMOVED
```

## Schema (migration `004_tailnet.sql`)

- `settings(key PRIMARY KEY, value, updated_at)` — generic key-value store. Phase-4 keys:
  `tailscale.oauth-client-id`, `tailscale.oauth-client-secret-ref` (a **vault ref**, never the
  secret), `tailscale.tag`.
- `environments` gained `tailnet_device_id`, `ts_authkey_ref` (vault ref of the minted key,
  cleared after join), `ts_authkey_id` (Tailscale-side key id, for API deletion), and
  `status_detail` (human-readable progress note during slow waits; cleared on success/error).
- Dropped: `environments.host_port`, `nodes.endpoint_host` (node-port path removed).

## Required manual provisioning (operator)

Documented in `fleet/deploy/tailscale.md`: enable **MagicDNS** and **HTTPS certificates** on the
tailnet; define `tag:t3-controller`/`tag:t3-node`/`tag:t3-env` in `tagOwners`; apply the
recommended ACLs (operator devices → env:443 and controller:9400; nodes → controller:9400;
controller → env:443; **no rule with `src: tag:t3-env`**); create an OAuth client with scopes
**`auth_keys` (write)** + **`devices:core` (write)** and tag `tag:t3-env`; hand it to the
controller via `PUT /api/settings/tailscale`. The controller host must be a tailnet member with
working MagicDNS resolution. New env vars: `FLEET_CONTROLLER_TAILSCALE_API_URL`,
`FLEET_CONTROLLER_TS_AUTHKEY_TTL_SECONDS`, `FLEET_CONTROLLER_TAILNET_JOIN_TIMEOUT_MS`,
`FLEET_CONTROLLER_TAILNET_ENDPOINT_SCHEME` (test seam — see below).

## Decisions the plan delegated (with rationale)

1. **Auth keys**: single-use (`reusable: false`), **non-ephemeral**, `preauthorized: true`,
   `tags: [tag:t3-env]`, `expirySeconds` 3600 by default. Non-ephemeral because suspended
   devices must not be garbage-collected; deletion is explicit on destroy. The minted key is
   vault-encrypted with its ref on the row so a controller crash between mint and container
   create resumes with the same key; after the device joins, the key is deleted from the vault
   and (best-effort) from Tailscale. **Never re-minted past `key-minted`** — tested explicitly.
2. **Key transport stopgap**: the key reaches the container as `TS_AUTHKEY` in
   `CreateEnvironmentSpec.env` (like the official Tailscale Docker image). It transits the
   agent WS as cleartext JSON and is visible in `docker inspect` on the node until it expires.
   Accepted for phase 4 because it is single-use, short-TTL, and never logged; **phase 5's
   sealed credential injection must absorb this path**. The entrypoint unsets it before
   `t3 serve` so provider CLIs never see it.
3. **OAuth client via settings + vault**, not env config: `PUT /api/settings/tailscale`
   (accepted once, never returned), status via GET. Reconfiguring replaces and deletes the old
   vault ref. Create fails fast (409 `TailnetNotConfiguredError`) when unconfigured.
4. **No tailnet-name setting**: the endpoint is derived from the joined device's MagicDNS `name`
   returned by `GET /api/v2/tailnet/-/devices` (`https://<name>`), with the `-` tailnet alias
   everywhere. Device id preference: `nodeId` over legacy `id`.
5. **Status polling goes over the tailnet URL** — the same path clients use, keeping observed
   state honest; the agent protocol stays lean (no new request types; `PROTOCOL_VERSION` still
   1 — removals only, no mixed deployments).
6. **Slow cert issuance**: the `healthy` step writes `status_detail`
   ("waiting for the T3 server to answer over the tailnet …") while retrying up to
   `environmentHealthTimeoutMillis`; `tailnet-joined` similarly reports the join wait. Details
   are cleared on success and by `markError`.
7. **TUN mode**: the entrypoint probes `/dev/net/tun` — present → kernel mode (expected under
   sysbox, which exposes it), absent → `--tun=userspace-networking` (plain runc). Inbound
   Tailscale Serve behaves identically. `--accept-dns=false` keeps container DNS untouched
   (environments only serve inbound; they never resolve tailnet peers).
8. **First-join vs rejoin detection** uses `tailscale status --json` `BackendState`
   (`NeedsLogin` → first join, needs `TS_AUTHKEY`; anything else → `tailscale up` **without**
   a key). State-file existence is not enough: tailscaled writes a machine key before login, so
   a failed first join would otherwise wedge the retry path.
9. **Join logic stays inline in `entrypoint.sh`** (the plan suggested a sourceable file);
   `image/entrypoint.test.ts` runs the _whole real entrypoint_ against PATH-stubbed
   `tailscaled`/`tailscale`/`t3`, which tests the actual composition. Test-only env overrides
   (`T3ENV_TS_STATE_DIR`, `T3ENV_TS_SOCKET`, `T3ENV_TUN_DEVICE`, `T3ENV_LOG_DIR`) exist for
   this; production never sets them.
10. **Test seam for endpoints**: `tailnetEndpointScheme` config (default `https`; `http` only
    for tests). The docker integration test's fake Tailscale API reports each container's
    bridge IP + `:3773` as its device "name", so the controller's tailnet endpoints are real,
    reachable T3 servers without a tailnet. The lifecycle test image sets
    `T3ENV_SKIP_TAILSCALE=1`.
11. **Destroy semantics**: device deletion is a _hard_ step (failure fails the destroy, which
    reconciliation retries — convergence preserved; 404 counts as success), with a hostname
    lookup fallback when no device id was recorded (crash between join and record). Leftover
    minted-but-unused keys are removed from the vault (hard) and Tailscale (best-effort). An
    _unconfigured_ tailnet only warns — nothing can be deleted without the OAuth client.

## Security paths (all automated-tested)

- OAuth client secret: vault-encrypted, only its ref in SQLite; never returned by any endpoint;
  API errors carry HTTP status + bounded body, never credentials (asserted for a wrong-secret
  401). Old secret deleted from the vault on reconfigure.
- Minted auth keys: vault-encrypted at rest, deleted after the device joins; the full-create
  test scans every byte under `dataDir` (SQLite, vault, archives) for the OAuth secret, every
  minted key, and every T3 bearer token.
- The `t3 auth session issue` output-handling and pairing-link invariants from phase 3 are
  unchanged and still covered.

## Tests (64 total incl. the docker integration test, all green)

New: `controller/src/tailnet/Tailnet.test.ts` (4 — token exchange + caching, mint body shape,
device find/delete with 404 tolerance, unconfigured/secret-hiding, vault storage + reconfigure),
`image/entrypoint.test.ts` (6 — first join with key, kernel-vs-userspace TUN, **rejoin never
passes a key** across three boots, missing-key abort, failed-join abort, skip modes).
Reworked: `Environments.test.ts` (fake Tailscale API in the stack; full create asserts the mint
body, `TS_AUTHKEY`/`T3ENV_TS_HOSTNAME`/`T3CODE_TAILSCALE_SERVE` in the create spec and _no_
`publishPorts`; key cleanup everywhere; restart-reconcile resumes from `key-minted` **with zero
mint requests**; destroy deletes the device; `TailnetNotConfiguredError` on create),
`Lifecycle.docker.test.ts` (fake tailnet resolving container bridge IPs; destroy asserts device
deletion), plus protocol/driver/socket test updates for the removals.

Gotcha for docker-CLI users: Docker 29 removed the top-level `.NetworkSettings.IPAddress`
inspect field — use `{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}`.

## Validation performed

- `pnpm typecheck`, `pnpm lint`, `pnpm test` clean inside `fleet/` (64 tests; the docker
  integration test ran against this VM's real Docker 29 under `runc`).
- `t3env:dev` rebuilt with the new entrypoint.
- Manual real-image run (runc, fake key): tailscaled started in userspace mode with state on the
  volume, the join reached the real Tailscale control plane
  (`backend error: invalid key: unable to validate API key`), and the boot aborted loudly with
  exit 1 — the failure path behaves as designed against real binaries.

### Manual validation on a real tailnet (performed, end to end)

Run against the operator's personal tailnet `bearded-godzilla.ts.net` (default Personal-plan
feature set — MagicDNS + HTTPS certificates enabled were sufficient; ~6 devices), with a real
OAuth client (scopes `auth_keys` write + `devices:core` write, tag `tag:t3-env`), a real
controller + agent on this host driving `t3env:dev` under `runc`:

1. **Create → ready**: OAuth token exchange, tagged key mint, container joined as
   `env-86c3a6f3` (userspace tailscaled, state on the volume), device discovered, environment
   `ready` at `https://env-86c3a6f3.bearded-godzilla.ts.net` in ~1 minute. The
   `status_detail` cert-wait message was observable during the `tailnet-joined → healthy`
   window, and the certificate chain validated as publicly trusted (`curl ssl_verify_result 0`).
2. **Pairing from another tailnet device**: the operator opened the minted
   `/pair#token=…` URL from a macOS device — valid HTTPS padlock, pairing succeeded, and the
   chat UI worked over WSS (confirmed by the operator).
3. **Restart keeps the URL**: `docker restart` → second boot logged
   "existing tailscale identity found — rejoining" (no auth key), the same URL answered again
   within seconds, and the tailnet still had exactly one `env-86c3a6f3` device with the same
   node id (`tailscale up --hostname --accept-dns=false` re-run semantics verified against the
   real CLI).
4. **Destroy removes the device**: container + volume gone, environment `destroyed`, and the
   device disappeared from the tailnet (device list back to its pre-test count).

Host note: this box is an unprivileged Proxmox LXC whose own tailscaled runs userspace-mode, so
the controller could not reach `*.ts.net` transparently. Workaround used (and reverted after):
`--outbound-http-proxy-listen=localhost:1055` on the host tailscaled +
`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:1055` on the controller process — Node 24's
built-in fetch honors the env proxy, no fleet code changes. A controller host with kernel-TUN
tailscaled needs none of this; consider documenting the proxy recipe in phase 8 if LXC-hosted
controllers should be supported.

### Still pending on real hardware

1. Kernel-TUN mode under **sysbox** (no sysbox on this VM; the real-tailnet run used userspace
   networking under `runc` — inbound serving is identical by design, but the sysbox TUN path
   itself is unexercised). Sysbox items from phases 2–3 remain pending as before.

## Notes to later phases

- **Phase 5 (vault)**: absorb the `TS_AUTHKEY`-via-env stopgap into the sealed credential
  injection (decision 2). `TailnetSettings` uses the same minimal `Vault.store/read/delete` you
  are generalizing; the `settings` table is generic key-value if you need it. Entrypoint
  credential materialization slots in _after_ the tailnet join, before the clone.
- **Phase 6 (dashboard)**: `EnvironmentSummary` gained `tailnetDeviceId` and `statusDetail` —
  surface `statusDetail` during creates (it is the "waiting for cert" UX). Tailscale settings
  UI: `GET`/`PUT /api/settings/tailscale` (never displays a secret; PUT payload
  `{clientId, clientSecret, tag?}`). Create returns 409 `TailnetNotConfiguredError` until
  configured — a good empty-state hint.
- **Phase 7 (policies/updates)**: suspend = stop the container; the device goes offline but is
  **not** deleted and no key is needed to wake (the entrypoint rejoins from volume state). Image
  updates (recreate with the same volume) likewise need no tailnet work. Do not delete devices
  anywhere except destroy. `StatusPoller` marks a suspended environment `unreachable` — you will
  want a `suspended` observed state instead.
- **Phase 8 (packaging)**: `fleet/deploy/tailscale.md` is the operator networking doc — link it
  from the compose/join story. The controller needs outbound HTTPS to
  `api.tailscale.com` and tailnet+MagicDNS for polling. `join.sh` should verify tailnet
  membership on nodes (the spec's prerequisite) but agents need no Tailscale API access.
  Controller backup story is unchanged (SQLite + vault dir now also carries the OAuth secret).
