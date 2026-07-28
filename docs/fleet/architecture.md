# T3 Fleet — Self-Hosted Environment Orchestration

Status: draft architecture spec.
Audience: advanced homelab operators self-hosting T3 Code on their own hardware.

T3 Fleet runs many independent, disposable T3 Code environments on homelab machines, managed from
one dashboard. Each environment is a full Linux workspace (own clone of the project, own services
such as Supabase, own terminals) running one T3 server. A central controller owns the machine pool,
the base image, and a credential vault.

Fleet targets one complete working release, not a phased rollout. Everything in this spec is
in scope for v1 unless it appears in [Explicitly Deferred](#explicitly-deferred).

## Goals

- Create and destroy isolated environments for the same project on demand.
- Run each environment as its own Linux system where the agent can install packages and run nested
  containers (for example `supabase start`).
- Manage all environments from one central UI, and open a T3 chat in any of them in one click.
- Maintain one base image in a central place so bundled dependencies (provider CLIs, git, Node,
  tooling) update in one commit.
- Store all credentials centrally (provider auth, API keys, git) and inject them per environment.
- No public domain, DNS zone, or certificate management required. Joining a tailnet is the only
  networking prerequisite.
- Track upstream T3 Code with low maintenance cost. A small fork is acceptable when it buys real
  product value; unbounded divergence is not.

## Non-goals

- Multi-tenant SaaS concerns: billing, per-user quotas, public sign-up.
- Replacing T3 Connect. The hosted relay solves discovery over the public internet for arbitrary
  clients; Fleet assumes every participating device is on the operator's tailnet.
- Windows or macOS worker nodes. Nodes are Linux hosts (bare metal or VMs).
- High availability of the control plane. The controller is a single instance with backups, which
  matches homelab reality.
- Public-internet exposure of environments. Access is tailnet-only by design.

## Design Principles

1. **Low-drift, not zero-fork.** Fleet consumes upstream's stable operator interfaces (the `t3`
   CLI, the environment HTTP auth API, pairing URLs) wherever they suffice. Forking is allowed
   when a small patch buys real value, under the policy in
   [Upstream Tracking Policy](#upstream-tracking-policy).
2. **One environment = one T3 server.** This is upstream's own execution boundary
   (see [Remote Architecture](../architecture/remote.md)). Fleet adds lifecycle around that unit;
   it never splits it.
3. **The volume and git are the durable state.** Containers are disposable; the per-environment
   volume (workspace, T3 state, inner Docker data) and pushed commits are what persist. Anything
   written to the container root filesystem is legitimately lost on recreate.
4. **The tailnet is the network.** Every environment, node, controller, and client device is a
   tailnet peer. Fleet manages no reverse proxy, no DNS zone, and no certificates.
5. **Controller state is boring.** One SQLite database, one secrets file, one process. Restoring a
   homelab controller must be `rsync` plus `docker compose up`.

## System Topology

```text
                         Tailnet (MagicDNS + HTTPS certs)
   ┌─────────────────────────────────────────────────────────────────┐
   │                                                                 │
   │  Browser / phone            fleet.<tailnet>.ts.net              │
   │  (any tailnet device) ────▶ fleet-controller                    │
   │        │                    (API + dashboard + vault + sched)   │
   │        │ chat traffic, direct        ▲                          │
   │        │                             │ outbound WebSocket       │
   │        ▼                             │ from each agent          │
   │  env-a1.<tailnet>.ts.net    ┌────────┴───────┐ ┌──────────────┐ │
   │  env-b2.<tailnet>.ts.net    │ Node A         │ │ Node B ...   │ │
   │        │                    │ Docker + sysbox│ │              │ │
   │        └──────────────────▶ │  fleet-agent   │ │  fleet-agent │ │
   │                             │  ┌───────────┐ │ │              │ │
   │                             │  │ env-a1    │ │ │              │ │
   │                             │  │ t3 serve  │ │ │              │ │
   │                             │  │ tailscaled│ │ │              │ │
   │                             │  │ dockerd   │ │ │              │ │
   │                             │  │ supabase… │ │ │              │ │
   │                             │  └───────────┘ │ │              │ │
   │                             └────────────────┘ └──────────────┘ │
   └─────────────────────────────────────────────────────────────────┘
```

Each environment is its own tailnet device with its own MagicDNS name and automatically issued
HTTPS certificate. Browsers talk to environments directly over the tailnet; the controller is a
control plane only. After pairing, chat traffic never touches the controller process.

## Components

### fleet-controller

A single long-running service (distributed as one container) that owns:

- **Inventory**: registered nodes, their capacity, and health.
- **Environments**: desired state (project, node, image, credential profile, idle policy) and
  observed state (running, suspended, unreachable).
- **Vault**: encrypted credential store and injection profiles.
- **Image policy**: which base image tag new environments use.
- **Tailnet integration**: a Tailscale OAuth client (stored in the vault) used to mint tagged auth
  keys for new environments and nodes, and to delete devices when environments are destroyed.
- **Dashboard**: the management UI.
- **Scheduler**: picks a node for new environments (bin-packing on free memory, or an explicit node
  choice by the operator).

State lives in one SQLite database. Secrets are encrypted at rest with an `age` identity kept
outside the database so a leaked DB file alone reveals nothing.

### fleet-agent

One per node, running as a container with access to the node's Docker socket. It dials the
controller's tailnet name over an outbound WebSocket using a join token, so nodes need no open
inbound ports and multi-site homelabs (machines in different flats, an off-site VPS) work without
any extra networking. It executes container lifecycle commands (pull, create, start, stop, destroy,
exec), streams logs and stats, and proxies the controller's `exec` calls used during environment
bootstrap (`t3 project add`, `t3 auth session issue`).

The agent implements a small driver interface (`createEnvironment`, `startEnvironment`, ...). The
only driver in scope is `docker`. A future `kubernetes` or `proxmox-lxc` driver can slot in behind
the same interface without touching the controller model.

### Environment container

Runs the base image under the **sysbox** runtime (`--runtime=sysbox-runc`) so an unprivileged
container gets a working inner Docker daemon. This is what makes `supabase start`, testcontainers,
and arbitrary `docker compose` stacks work inside an environment without giving the environment
root on the node.

Inside each environment:

- `tailscaled`, joined with a controller-minted tagged auth key; its state directory lives on the
  environment volume so the device identity and MagicDNS name are stable across restarts,
  suspends, and image updates
- `t3 serve --tailscale-serve`, which binds the T3 server and asks Tailscale Serve to publish it at
  `https://env-<id>.<tailnet>.ts.net/` with an automatically issued certificate (this flag and the
  underlying behavior are upstream features)
- an inner `dockerd` whose data root is on the environment volume
- the project workspace, cloned at creation
- a `credsync` helper (see [Credential Vault](#credential-vault))

One named Docker volume per environment holds the home directory, the Tailscale state, and the
inner Docker data root. Suspend/resume keeps the volume; destroy removes it.

### Base image

One `t3env` OCI image, built from a Dockerfile kept in the fleet repo:

- Ubuntu LTS base, Node 24 (matching upstream `engines.node`)
- T3 Code server: the published package at a pinned version (or the fork's build)
- Provider CLIs at pinned versions: `codex`, `@anthropic-ai/claude-code`, `cursor-agent`,
  `opencode`
- `tailscale`/`tailscaled`
- git, gh, ripgrep, build-essential, docker CLI + compose (inner daemon comes from sysbox)
- the `credsync` helper and the entrypoint script

Updating a bundled dependency is a one-line version bump, an image build, and a push to a registry
(the controller can embed one, or use an existing homelab registry).

## Networking

Fleet's answer to "how do browsers reach environments over HTTPS without the operator owning a
domain" is: **Tailscale everywhere**.

- The operator's devices, all nodes, the controller, and every environment join one tailnet.
- Each environment is its own tailnet device named `env-<id>`, so it gets
  `https://env-<id>.<tailnet>.ts.net/` with a publicly trusted, automatically renewed certificate.
  This satisfies the browser's HTTPS/WSS requirements with zero PKI work.
- T3 Code already treats Tailscale as a first-class endpoint provider (`t3 serve
--tailscale-serve`, Tailnet endpoint discovery in the clients), so Fleet is leaning on supported
  upstream behavior rather than inventing a transport.
- Access control is tailnet ACLs on tags: `tag:t3-controller`, `tag:t3-node`, `tag:t3-env`.
  Environments accept traffic only from the operator's devices; environments cannot reach each
  other or the nodes.
- The controller mints per-environment auth keys through a Tailscale OAuth client and deletes
  devices through the API on destroy. Device identity persists on the environment volume, so an
  environment keeps its URL for life.

Inside the container, `tailscaled` runs in userspace-networking mode if the runtime does not expose
a TUN device; inbound serving works the same either way.

Trade-offs accepted:

- A Tailscale account is required. The free plan's device allowance (currently 100) is ample for a
  homelab fleet; each environment consumes one device while it exists.
- The Tailscale coordination plane is a third-party dependency. Established WireGuard sessions keep
  working during a coordination outage; new joins and cert issuance degrade.
- Headscale (self-hosted coordination) mostly works for connectivity, but automatic HTTPS
  certificates for `ts.net`-style names are the weak point. Headscale support is best-effort, not a
  v1 requirement.

A conventional custom-domain reverse proxy (wildcard DNS + ACME) remains possible in principle —
nothing in the design depends on Tailscale-specific behavior beyond endpoint publication — but it
is out of scope and not maintained as a first-class path.

## Environment Lifecycle

Create:

1. Operator (or automation) requests an environment: project git URL + branch, node (or auto),
   credential profile, optional service preset.
2. Controller schedules it, allocates `env-<id>`, mints a tagged Tailscale auth key, and instructs
   the node's agent.
3. Agent pulls the image if needed and creates the container (sysbox runtime, environment volume).
4. Entrypoint: start `tailscaled` and join the tailnet, materialize injected credentials (env vars
   - files), clone the repo, run the setup hook if the project defines one, `t3 project add
<path>`, then start `t3 serve --tailscale-serve`.
5. Agent execs `t3 auth session issue --json` inside the container. The controller exchanges the
   result and stores a scoped session per environment for status polling and for minting pairing
   links later.
6. Controller marks the environment ready at `https://env-<id>.<tailnet>.ts.net/`.

Open chat:

1. Dashboard button calls the controller, which uses its stored admin session against the
   environment's auth API to create a fresh one-time pairing link
   (equivalent of `t3 auth pairing create --base-url https://env-<id>.<tailnet>.ts.net`).
2. The browser is sent to `https://env-<id>.<tailnet>.ts.net/pair#token=...`. The T3 server serves
   its own web UI, so no separate hosted web app is required; the token never leaves the URL hash.
3. The T3 web client pairs, stores the environment browser-locally, and opens the normal chat UI.

Suspend / resume:

- The controller polls each environment's status endpoint; after a configurable idle window with no
  active turns or attached terminals, the agent stops the container (volume retained). The
  environment's tailnet device goes offline but is not deleted, so its name and URL are reserved.
- Resume is controller-driven: waking an environment from the dashboard starts the container, which
  rejoins the tailnet under the same identity. Already-paired T3 clients reconnect automatically
  once the same URL is reachable again; there is no wake-on-access proxy page because there is no
  proxy.
- Inner services (Supabase and friends) cold-start on demand after resume; their data is on the
  volume.

Destroy:

- Optional final `git push` / patch archive of uncommitted work into controller storage.
- Stop container, delete volume, revoke the controller's session, delete the tailnet device.

## Image Updates and Data Durability

An image update is a **container recreate with the same volume reattached**. The volume boundary
defines what survives:

Survives every recreate:

- the workspace: clone, local files, uncommitted changes
- `T3CODE_HOME`: threads, sessions, project registration, and the environment's auth database —
  already-paired clients and the controller's stored session keep working without re-pairing
- the inner Docker data root: inner images, containers, and volumes, including a provisioned
  Supabase database; services cold-start against existing data after the swap
- the Tailscale identity: same device, same URL

Lost by design:

- anything on the container root filesystem, including packages installed with `apt` during a
  session. This is an accepted trade. Projects that need system packages should declare them in a
  **setup hook** (a devcontainer-style script in the repo or environment template that the
  entrypoint runs on every create/recreate), or the package should be promoted into the base
  image — which is exactly what central image management is for.

The dashboard shows which environments run outdated images and offers "update", which performs the
stop → recreate → rejoin sequence with seconds-to-a-minute of downtime.

One version-skew caveat: T3's own state migrations are forward-only, so upgrading the image
migrates `T3CODE_HOME`, but rolling back to an older image against a migrated volume may not work.
The agent therefore snapshots the volume (a local tarball, retained briefly) before every image
update so a bad update can be rolled back losslessly.

## Machine Provisioning

Nodes are ordinary Linux hosts. Fleet does not require Kubernetes; the deliberate trade is
"one agent + Docker + sysbox" instead of a cluster stack, because homelab nodes are few, are
heterogeneous, and nested-container support has to be configured on the host either way.

A node needs: a recent LTS distro, Docker Engine, sysbox-runc, tailnet membership, and the agent.
Provisioning is one path: a join script from the dashboard:

```bash
curl -fsSL https://fleet.<tailnet>.ts.net/join.sh | sudo sh -s -- --token <join-token>
```

The script is idempotent and non-interactive: it installs Docker and sysbox if missing, verifies
tailnet connectivity, and starts the `fleet-agent` container with the single-use join token. The
agent receives its own credential on first connect.

Because the script is idempotent and takes everything as flags, a future cloud-init path is just a
`user-data` snippet running the same script — kept deliberately doable, but not shipped in v1
(see [Explicitly Deferred](#explicitly-deferred)).

Node loss is tolerated, not masked: environments on a dead node show unreachable, and their
uncommitted work is gone unless pushed. This is the price of local volumes; network storage (NFS,
Ceph) is explicitly rejected because it drags in the failure modes Fleet tries to avoid. The
mitigations are cultural and cheap: agents commit early and often, and the idle suspender can run
`git push` to a fleet-owned backup remote before stopping a container.

## Credential Vault

The vault distinguishes three credential kinds because they behave differently:

1. **Environment variables** (API keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...). Injected into
   the container environment at creation. The T3 server forwards its process environment to
   provider CLIs, so this needs no T3 changes.
2. **File bundles** (subscription/OAuth state: `~/.claude`, `~/.codex`, `~/.cursor`,
   `~/.config/gh`). Captured once by the operator ("vault import" from a machine where the CLI is
   logged in), stored encrypted, and materialized into the home volume before `t3 serve` starts.
3. **Git credentials.** v1 injects a PAT or an existing `gh` login as a file bundle. A GitHub App
   flow (controller mints short-lived installation tokens per environment through a local
   credential helper) is the better long-term design and is deferred.

Injection is push-based and happens exactly once per container creation. The vault payload travels
controller → agent → container filesystem, sealed to the agent's key; it is never baked into the
image or written to controller logs.

**Token refresh.** Provider CLIs rotate OAuth tokens in place. The `credsync` helper in each
environment watches the bundle paths and reports changed tokens back to the controller
(last-writer-wins, with a dashboard warning on rapid conflicting writes from multiple
environments). Operators should also expect provider-side rate limits and terms-of-service
constraints when one subscription backs many concurrent environments; Fleet surfaces usage per
environment but cannot lift those limits.

Profiles group secrets ("personal", "work") and are chosen per environment at creation, so a work
project never receives personal git credentials.

## Upstream Tracking Policy

Fleet prefers upstream's stable operator surfaces, all of which are consumed without code changes:

| Surface                                            | Used for                                    |
| -------------------------------------------------- | ------------------------------------------- |
| `t3 serve` + `T3CODE_*` env config                 | Running the server headless in containers   |
| `t3 serve --tailscale-serve`                       | HTTPS publication on the tailnet            |
| `t3 project add` / `t3 project ...`                | Registering the workspace clone             |
| `t3 auth pairing create` / `t3 auth session issue` | Bootstrap and per-click pairing credentials |
| `POST /oauth/token`, `/api/auth/*`                 | Exchanging and using scoped sessions        |
| `/pair#token=...` URL format                       | Opening chats from the dashboard            |
| Environment status/descriptor endpoints            | Health and idle detection                   |

Forking is permitted under these rules:

- **A patch must buy visible product value** that cannot be had cleanly from the outside. UX polish
  inside the T3 clients is the expected category; plumbing that could live in Fleet is not.
- **Patches stay small and isolated**: one commit per patch on a dedicated branch that rebases onto
  upstream, each documented in the fleet repo with its purpose and its removal condition.
- **Upstream first**: anything generally useful is opened as an upstream PR, and the local patch
  carries a link and dies when the PR merges.

Current candidate patches, in priority order:

1. **Central environment directory in the clients.** The client runtime already models
   known-environment sources (`packages/client-runtime/src/environment/knownEnvironment.ts`); a
   small patch can populate the list from a Fleet controller URL so every paired browser sees the
   same fleet without per-browser pairing residue. This is the highest-value patch because it turns
   "N bookmarks" into "one environment switcher".
2. **Reconnect-aware wake UX**: a friendlier "environment is waking" state when a suspended
   environment's URL is temporarily unreachable.

The heavier alternative — implementing the T3 Connect relay HTTP contract
(`packages/contracts/src/relay.ts`) in the controller so stock clients use the existing cloud UI —
is acknowledged but not planned: it inherits the relay's Clerk-based client auth, which is a poor
fit for a homelab. The small directory patch above achieves the same UX for less total maintenance.

## Security Model

- **Environment access** uses T3's own scoped session model end to end. The controller holds one
  admin-scoped session per environment; humans get ordinary one-time pairing links. Nothing
  bypasses the environment's auth.
- **Network access** is tailnet membership plus ACLs: only the operator's devices can reach
  environments; environments cannot reach each other, the nodes, or the controller's admin API.
  There is no LAN or public exposure at all.
- **Node channel**: agents authenticate to the controller with per-node credentials issued at join;
  all agent traffic is outbound over the tailnet.
- **Isolation**: sysbox gives environments an unprivileged root and a private Docker daemon.
  Environments are untrusted by default — an agent inside one can do anything to that environment,
  and only that environment.
- **Vault**: secrets encrypted at rest (`age`), master identity kept outside the database, secrets
  sealed per-agent in transit, never logged.

## Failure Modes

| Failure                           | Behavior                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Controller down                   | Running environments keep working (browser ↔ env is direct); no create/suspend/wake until restored. |
| Node down                         | Its environments show unreachable; uncommitted work lost unless pushed.                             |
| Tailscale coordination outage     | Existing WireGuard sessions keep working; new device joins, wakes, and cert renewals degrade.       |
| Vault key lost                    | Secrets unrecoverable by design; re-import credentials.                                             |
| Provider token rotated externally | `credsync` reports drift; dashboard flags the profile for re-import.                                |
| Bad image update                  | Roll back from the pre-update volume snapshot.                                                      |

Controller backup = SQLite file + `age` identity. Both are small files on one host.

## Delivery Scope

v1 is one working release containing:

- controller + dashboard + vault (env vars, file bundles, `credsync` write-back)
- multi-node support with the join script and the `docker`/sysbox driver
- Tailscale-everywhere networking with per-environment devices, ACL tags, and device lifecycle
- full environment lifecycle: create, open chat via pairing links, idle suspend, dashboard wake,
  destroy
- base image pipeline with pinned provider CLIs, "update" (recreate on latest) with pre-update
  volume snapshots, and setup-hook support

### Explicitly Deferred

- cloud-init node provisioning (the join script is already shaped for it)
- Proxmox/NixOS node providers
- GitHub App short-lived git credentials
- the client directory and wake-UX fork patches (v1 works with stock clients; the patches are
  additive UX)
- Headscale as a supported coordination plane

## Open Questions

- Whether suspend should also snapshot inner-Docker container state or let services cold-start on
  resume; v1 lets them cold-start.
- Whether per-environment resource limits (cgroup memory/CPU caps) should be per-template or
  per-node defaults.
- How far `credsync` write-back can go safely for each provider CLI; needs per-provider testing
  against token rotation behavior.
- Whether the tailnet device-per-environment model needs a pool cap and reuse strategy for
  operators who churn environments very aggressively (device counts are bounded by plan limits).
