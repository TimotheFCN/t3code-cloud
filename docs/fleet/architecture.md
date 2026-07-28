# T3 Fleet — Self-Hosted Environment Orchestration

Status: draft architecture spec.
Audience: advanced homelab operators self-hosting T3 Code on their own hardware.

T3 Fleet runs many independent, disposable T3 Code environments on homelab machines, managed from
one dashboard. Each environment is a full Linux workspace (own clone of the project, own services
such as Supabase, own terminals) running one T3 server. A central controller owns the machine pool,
the base image, and a credential vault.

## Goals

- Create and destroy isolated environments for the same project on demand.
- Run each environment as its own Linux system where the agent can install packages and run nested
  containers (for example `supabase start`).
- Manage all environments from one central UI, and open a T3 chat in any of them in one click.
- Maintain one base image in a central place so bundled dependencies (provider CLIs, git, Node,
  tooling) update in one commit.
- Store all credentials centrally (provider auth, API keys, git) and inject them per environment.
- Track upstream T3 Code with zero or near-zero fork drift.

## Non-goals

- Multi-tenant SaaS concerns: billing, per-user quotas, public sign-up.
- Replacing T3 Connect. The hosted relay solves discovery over the public internet; Fleet assumes a
  LAN or tailnet the operator controls.
- Windows or macOS worker nodes. Nodes are Linux hosts (bare metal or VMs).
- High availability of the control plane. The controller is a single instance with backups, which
  matches homelab reality.

## Design Principles

1. **Zero-fork.** Fleet is a separate service beside T3 Code, not a modification of it. It consumes
   only interfaces upstream treats as stable: the `t3` CLI, the environment HTTP auth API, and the
   pairing URL format. `apps/server` and `apps/web` are not patched.
2. **One environment = one T3 server.** This is upstream's own execution boundary
   (see [Remote Architecture](../architecture/remote.md)). Fleet adds lifecycle around that unit; it
   never splits it.
3. **Git is the source of truth.** Environments are cattle. Durable output leaves an environment as
   commits and pushes; everything else is reconstructable from the base image plus the vault.
4. **Controller state is boring.** One SQLite database, one secrets file, one process. Restoring a
   homelab controller must be `rsync` plus `docker compose up`.

## System Topology

```text
                    ┌─────────────────────────────────────────────┐
                    │ Controller host                             │
                    │                                             │
   Browser ────────▶│  fleet-controller (API + dashboard + vault) │
                    │  ingress proxy (wildcard TLS)               │
                    │  OCI registry (optional, or external)       │
                    └───────┬─────────────────────────────────────┘
                            │ outbound WebSocket from each agent
            ┌───────────────┼───────────────────┐
            │               │                   │
   ┌────────▼───────┐ ┌─────▼──────────┐ ┌──────▼─────────┐
   │ Node A (bare   │ │ Node B (Proxmox│ │ Node C ...     │
   │ metal, Docker  │ │ VM, Docker +   │ │                │
   │ + sysbox)      │ │ sysbox)        │ │                │
   │  fleet-agent   │ │  fleet-agent   │ │  fleet-agent   │
   │  ┌───────────┐ │ │  ┌───────────┐ │ │                │
   │  │ env-a1    │ │ │  │ env-b1    │ │ │                │
   │  │ t3 serve  │ │ │  │ t3 serve  │ │ │                │
   │  │ dockerd   │ │ │  │ dockerd   │ │ │                │
   │  │ supabase… │ │ │  └───────────┘ │ │                │
   │  └───────────┘ │ └────────────────┘ └────────────────┘
   └────────────────┘
```

Browsers talk to environments directly through the ingress proxy. The controller is a control
plane only: after pairing, chat traffic flows browser → proxy → environment, never through the
controller process.

## Components

### fleet-controller

A single long-running service (distributed as one container) that owns:

- **Inventory**: registered nodes, their capacity, and health.
- **Environments**: desired state (project, node, image, credential profile, idle policy) and
  observed state (running, suspended, unreachable).
- **Vault**: encrypted credential store and injection profiles.
- **Image policy**: which base image tag new environments use.
- **Dashboard**: the management UI.
- **Scheduler**: picks a node for new environments (bin-packing on free memory, or an explicit node
  choice by the operator).

State lives in one SQLite database. Secrets are encrypted at rest with an `age` identity kept
outside the database so a leaked DB file alone reveals nothing.

### fleet-agent

One per node, running as a container with access to the node's Docker socket. It dials the
controller over an outbound WebSocket using a join token, so nodes need no open inbound ports and
can sit behind NAT segments of the LAN. It executes container lifecycle commands (pull, create,
start, stop, destroy, exec), streams logs and stats, and proxies the controller's `exec` calls used
during environment bootstrap (`t3 project add`, `t3 auth pairing create`).

The agent implements a small driver interface (`createEnvironment`, `startEnvironment`, ...). The
only driver in scope is `docker`. A future `kubernetes` or `proxmox-lxc` driver can slot in behind
the same interface without touching the controller model.

### Environment container

Runs the base image under the **sysbox** runtime (`--runtime=sysbox-runc`) so an unprivileged
container gets a working systemd-less inner Docker daemon. This is what makes `supabase start`,
testcontainers, and arbitrary `docker compose` stacks work inside an environment without giving the
environment root on the node.

Inside each environment:

- `t3 serve` bound to `0.0.0.0` (`T3CODE_HOST`), state under `T3CODE_HOME`
- an inner `dockerd` for the agent's workloads
- the project workspace, cloned at creation
- a `credsync` helper (see [Credential Vault](#credential-vault))

One named Docker volume per environment holds the home directory (workspace, `T3CODE_HOME`, inner
Docker storage). Suspend/resume keeps the volume; destroy removes it.

### Ingress proxy

Caddy (or Traefik) with a wildcard route: `env-<id>.<fleet-domain>` → node IP : mapped port. The
controller writes route updates through the proxy's API when environments start and stop. TLS
options, in order of homelab friendliness:

1. **ACME DNS-01 wildcard** on a real domain (no inbound port 80/443 from the internet needed).
2. **Tailscale**: put the proxy host on the tailnet and use its HTTPS certs; every device on the
   tailnet reaches every environment.
3. **Internal CA** (`step-ca`, `mkcert`) for fully offline labs, at the cost of installing the root
   on client devices.

HTTPS is not optional: T3's web client is served over HTTPS, and browsers refuse `ws://` from HTTPS
pages, so environments must be reachable over `wss://`.

### Base image

One `t3env` OCI image, built from a Dockerfile kept in the fleet repo:

- Ubuntu LTS base, Node 24 (matching upstream `engines.node`)
- T3 Code server: the published package at a pinned version (or the fork's build)
- Provider CLIs at pinned versions: `codex`, `@anthropic-ai/claude-code`, `cursor-agent`,
  `opencode`
- git, gh, ripgrep, build-essential, docker CLI + compose (inner daemon comes from sysbox)
- the `credsync` helper and the entrypoint script

Updating a bundled dependency is a one-line version bump, an image build, and a push to the
registry. The controller records the new digest; existing environments keep their image until
recycled (immutable infrastructure — no in-place updates inside environments). The dashboard shows
which environments run outdated images and offers "recreate on latest".

## Environment Lifecycle

Create:

1. Operator (or automation) requests an environment: project git URL + branch, node (or auto),
   credential profile, optional service preset.
2. Controller schedules it, allocates `env-<id>`, and instructs the node's agent.
3. Agent pulls the image if needed and creates the container (sysbox runtime, env volume, a
   host-port mapping for the T3 server).
4. Entrypoint: materialize injected credentials (env vars + files), clone the repo, `t3 project add
<path>`, start `t3 serve`.
5. Agent execs `t3 auth session issue --json` inside the container and returns the result. The
   controller exchanges it and stores a scoped session per environment for status polling and for
   minting pairing links later (scopes: `orchestration:read access:write`).
6. Controller adds the ingress route and marks the environment ready.

Open chat:

1. Dashboard button calls the controller, which uses its stored admin session against the
   environment's auth API to create a fresh one-time pairing link
   (equivalent of `t3 auth pairing create --base-url https://env-<id>.<fleet-domain>`).
2. The browser is sent to `https://env-<id>.<fleet-domain>/pair#token=...`. The T3 server serves
   its own web UI, so no separate hosted web app is required; the token never leaves the URL hash.
3. The T3 web client pairs, stores the environment browser-locally, and opens the normal chat UI.

Suspend / resume:

- The controller polls each environment's status endpoint; after a configurable idle window with no
  active turns or attached terminals, the agent stops the container (volume retained).
- The ingress route for a suspended environment points to a controller-served wake page that
  triggers a start and reloads when the environment is healthy. Cold resume is seconds, not
  minutes, because the volume and image are local.

Destroy:

- Optional final `git push` / patch archive of uncommitted work into controller storage.
- Stop container, delete volume, revoke the controller's session, drop the ingress route.

## Machine Provisioning

Nodes are ordinary Linux hosts. Fleet does not require Kubernetes; the deliberate trade is
"one agent + Docker + sysbox" instead of a cluster stack, because homelab nodes are few, are
heterogeneous, and nested-container support has to be configured on the host either way.

A node needs: a supported kernel (any recent LTS distro), Docker Engine, sysbox-runc, and the
agent. Provisioning paths:

1. **Existing machine (default).** A join script from the dashboard:

   ```bash
   curl -fsSL https://fleet.example.com/join.sh | sudo sh -s -- --token <join-token>
   ```

   The script installs Docker and sysbox if missing, then starts the `fleet-agent` container with
   the join token. The token is single-use; the agent receives its own credential on first
   connect.

2. **Proxmox VMs.** A cloud-init snippet running the same join script in `user-data`, kept in the
   fleet repo as a documented template. Optionally, a `proxmox` node-provider in the controller
   drives the Proxmox API to clone the template on demand ("add node" from the dashboard), which
   gives elastic capacity on one big hypervisor without a cluster stack.

3. **NixOS module** (community-friendly option): a small module pinning Docker, sysbox, and the
   agent as declarative config.

Node loss is tolerated, not masked: environments on a dead node show unreachable, and their
uncommitted work is gone unless pushed. This is the price of local volumes; network storage (NFS,
Ceph) is explicitly rejected for v1 because it drags in the failure modes Fleet tries to avoid.
The mitigations are cultural and cheap: agents commit early and often, and the idle suspender can
run `git push` to a fleet-owned backup remote before stopping a container.

## Credential Vault

The vault distinguishes three credential kinds because they behave differently:

1. **Environment variables** (API keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...). Injected into
   the container environment at creation. The T3 server forwards its process environment to
   provider CLIs, so this needs no T3 changes.
2. **File bundles** (subscription/OAuth state: `~/.claude`, `~/.codex`, `~/.cursor`, `~/.config/gh`).
   Captured once by the operator ("vault import" from a machine where the CLI is logged in), stored
   encrypted, and materialized into the home volume before `t3 serve` starts.
3. **Git credentials.** Preferred: a GitHub App whose installation tokens the controller mints on
   demand; environments get a `git credential` helper that asks the local agent, which asks the
   controller. Tokens are short-lived and per-environment, so destroying an environment leaks
   nothing durable. Fallback: a static PAT injected as a file-bundle.

Injection is push-based and happens exactly once per container creation. The vault payload travels
controller → agent → container filesystem, sealed to the agent's key; it is never baked into the
image or written to controller logs.

**Token refresh caveat.** Provider CLIs rotate OAuth tokens in place. The `credsync` helper in each
environment watches the bundle paths and reports changed tokens back to the controller
(last-writer-wins, with a dashboard warning on rapid conflicting writes from multiple
environments). Operators should also expect provider-side rate limits and terms-of-service
constraints when one subscription backs many concurrent environments; Fleet surfaces usage per
environment but cannot lift those limits.

Profiles group secrets ("personal", "work") and are chosen per environment at creation, so a work
project never receives personal git credentials.

## Upstream Compatibility Contract

Fleet may consume only these T3 Code surfaces, all of which are operator-facing and stable:

| Surface                                            | Used for                                    |
| -------------------------------------------------- | ------------------------------------------- |
| `t3 serve` + `T3CODE_*` env config                 | Running the server headless in containers   |
| `t3 project add` / `t3 project ...`                | Registering the workspace clone             |
| `t3 auth pairing create` / `t3 auth session issue` | Bootstrap and per-click pairing credentials |
| `POST /oauth/token`, `/api/auth/*`                 | Exchanging and using scoped sessions        |
| `/pair#token=...` URL format                       | Opening chats from the dashboard            |
| Environment status/descriptor endpoints            | Health and idle detection                   |

Explicitly out of bounds: patching `apps/server`, `apps/web`, or `packages/*`. Fleet lives in its
own repository (or an isolated top-level directory in the fork) so upstream rebases stay
conflict-free.

A known UX gap is accepted for v1: each browser accumulates paired environments in local storage,
and the in-app environment list is not centrally driven. If tighter integration is wanted later,
the sanctioned path is implementing the T3 Connect relay HTTP contract
(`packages/contracts/src/relay.ts`) in the controller so stock clients list Fleet environments
through the existing cloud UI. That is additive server-side work in Fleet, not a client fork,
though it inherits the relay's Clerk-based client auth.

## Security Model

- **Environment access** uses T3's own scoped session model end to end. The controller holds one
  admin-scoped session per environment; humans get ordinary one-time pairing links. Nothing
  bypasses the environment's auth.
- **Node channel**: agents authenticate to the controller with per-node credentials issued at join;
  all agent traffic is outbound TLS.
- **Isolation**: sysbox gives environments an unprivileged root and a private Docker daemon.
  Environments are untrusted by default — an agent inside one can do anything to that environment,
  and only that environment.
- **Vault**: secrets encrypted at rest (`age`), master identity kept outside the database, secrets
  sealed per-agent in transit, never logged.
- **Network exposure**: the recommended posture is LAN/tailnet-only. Fleet does not attempt to make
  public-internet exposure safe; that is T3 Connect's job.

## Failure Modes

| Failure                           | Behavior                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Controller down                   | Running environments keep working (browser ↔ env is direct); no create/suspend/wake until restored. |
| Node down                         | Its environments show unreachable; uncommitted work lost unless pushed.                             |
| Ingress down                      | All environment access down; single shared dependency, kept deliberately dumb.                      |
| Vault key lost                    | Secrets unrecoverable by design; re-import credentials.                                             |
| Provider token rotated externally | `credsync` reports drift; dashboard flags the profile for re-import.                                |

Controller backup = SQLite file + `age` identity + proxy config. All three are small files on one
host.

## Rollout Phases

1. **MVP**: controller + agent on a single node (may be the same machine), manual join, `docker`
   driver, env-var credentials only, pairing deep-links, no suspend. Proves the full loop:
   create → pair → chat → destroy.
2. **Fleet basics**: multi-node, file-bundle credentials, idle suspend/wake, image update policy
   and "recreate on latest".
3. **Provisioning comfort**: Proxmox node provider, `credsync` write-back, GitHub App git
   credentials, backup remote on suspend.
4. **Optional deep integration**: relay-contract implementation in the controller for in-app
   environment lists in stock clients.

## Open Questions

- Whether the suspend policy should also snapshot inner-Docker state (Supabase containers) or let
  services cold-start on resume; v1 lets them cold-start.
- Whether per-environment resource limits (cgroup memory/CPU caps) should be per-template or
  per-node defaults.
- How far `credsync` write-back can go safely for each provider CLI; needs per-provider testing
  against token rotation behavior.
- Whether the relay-contract option is worth its Clerk dependency for a homelab, or whether a
  minimal fork of the client auth layer would ever be acceptable drift. Default answer: stay on
  pairing links.
