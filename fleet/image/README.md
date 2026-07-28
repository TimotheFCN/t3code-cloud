# t3env — the Fleet base image

One `t3env` container is one T3 Fleet environment: a full Linux workspace running one T3 Code
server, with an inner Docker daemon and the four provider CLIs on PATH. The agent's docker driver
(`fleet/packages/agent/src/driver/DockerDriver.ts`) creates these containers under the **sysbox**
runtime (`--runtime=sysbox-runc`), which is what makes the inner daemon work without
`--privileged`.

## Contents (all pinned as Dockerfile ARGs)

| Component                                         | ARG                                            |
| ------------------------------------------------- | ---------------------------------------------- |
| Ubuntu LTS base                                   | `UBUNTU_VERSION`                               |
| Node (matches upstream `engines.node`)            | `NODE_VERSION`                                 |
| T3 Code server (`t3` npm package)                 | `T3_VERSION`                                   |
| `codex` (`@openai/codex`)                         | `CODEX_VERSION`                                |
| `claude` (`@anthropic-ai/claude-code`)            | `CLAUDE_CODE_VERSION`                          |
| `opencode` (`opencode-ai`)                        | `OPENCODE_VERSION`                             |
| `cursor-agent` (versioned tarball)                | `CURSOR_AGENT_VERSION`                         |
| `tailscale` / `tailscaled` (static tarball)       | `TAILSCALE_VERSION`                            |
| GitHub CLI (`gh`)                                 | `GH_VERSION`                                   |
| Docker Engine + CLI + buildx + compose (apt pins) | `DOCKER_APT_VERSION`, `CONTAINERD_APT_VERSION` |

Plus unpinned base tooling from the Ubuntu archive: git, ripgrep, build-essential, curl, jq,
openssh-client, iproute2/iptables (needed by the inner dockerd).

Updating a bundled dependency is a one-line ARG bump, `./build.sh`, and a push.

## Volume layout (the durability contract)

The driver mounts one named volume per environment at **`/root`**. Everything an environment must
keep across image updates lives inside it:

| Path                 | Contents                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/root/.t3`          | `T3CODE_HOME`: threads, sessions, project registry, auth database                                                                                               |
| `/root/.docker-data` | inner Docker data root (`/etc/docker/daemon.json`)                                                                                                              |
| `/root/workspace`    | project clone                                                                                                                                                   |
| `/root/.tailscale`   | tailscaled state — the device identity that keeps the environment's `https://env-<id>.<tailnet>.ts.net` URL stable across restarts, suspends, and image updates |
| `/root/.claude` etc. | provider CLI state, injected/synced by the vault (phase 5)                                                                                                      |

Everything **outside** `/root` — including `apt` installs made during a session — is legitimately
lost when the container is recreated with a newer image. That is why every binary in this image
installs to `/usr/local`, never `/root`: a named volume is seeded from the image's `/root` on
first use and then persists, so anything under `/root` in the image would go stale after updates.

The inner Docker data root deliberately lives on the volume (a real host filesystem), which both
persists inner images/containers and sidesteps overlayfs-on-overlayfs; sysbox's special handling
of `/var/lib/docker` is not needed.

## Entrypoint

`entrypoint.sh` runs the bootstrap sequence on every container boot:

1. **Tailnet join** (when `T3ENV_TS_HOSTNAME` is set and `T3ENV_SKIP_TAILSCALE` is not `1`):
   start `tailscaled` with its state in `/root/.tailscale` (on the volume — stable device
   identity), in userspace-networking mode when `/dev/net/tun` is absent (sysbox exposes it, so
   production environments use kernel TUN). On the very first boot the join consumes the
   controller-minted single-use `TS_AUTHKEY`; every later boot detects the existing logged-in
   identity and rejoins **without any key** — the device (and its URL) is the same for life. A
   failed join aborts the boot loudly, and `TS_AUTHKEY` is unset before anything else starts.
2. Start the inner `dockerd` (waits up to 30s for the socket; warns and continues without it when
   the runtime cannot support it, e.g. plain `runc` in development). `T3ENV_SKIP_DOCKERD=1` skips
   it (useful in tests).
3. Clone `T3ENV_GIT_URL` (optionally `--branch T3ENV_GIT_BRANCH`) into `/root/workspace` — only
   when the volume does not already contain a clone, so recreates and restarts never touch an
   existing workspace.
4. Run the **setup hook** when the repo defines one: an executable `.t3env/setup.sh` at the repo
   root, executed from the workspace on every boot. It must be idempotent; this is where projects
   reinstall apt packages and other root-filesystem state that image updates legitimately lose. A
   failing hook aborts the boot loudly.
5. `t3 project add /root/workspace` (an already-registered workspace counts as success —
   `T3CODE_HOME` lives on the volume).
6. `t3 serve`, configured purely through `T3CODE_*` env vars — the controller sets
   `T3CODE_TAILSCALE_SERVE=1` so the server publishes itself at
   `https://<hostname>.<tailnet>.ts.net/` through Tailscale Serve (the certificate is issued on
   first request and cached in the tailscaled state on the volume). Image defaults:

```text
T3CODE_HOST=0.0.0.0  T3CODE_PORT=3773  T3CODE_HOME=/root/.t3  T3CODE_NO_BROWSER=1
```

Steps 3–5 are skipped entirely when `T3ENV_GIT_URL` is unset. Phase 5 adds credential
materialization before the clone. Test-only overrides (`T3ENV_TS_STATE_DIR`, `T3ENV_TS_SOCKET`,
`T3ENV_TUN_DEVICE`, `T3ENV_LOG_DIR`) let `entrypoint.test.ts` exercise the join logic with
stubbed binaries outside a container; production never sets them.

## Building and pushing

```bash
./build.sh                                        # t3env:dev, local only
TAG=0.1.0 REGISTRY=registry.lan:5000 PUSH=1 ./build.sh
BUILD_ARGS="--build-arg T3_VERSION=0.0.30" ./build.sh
```

No secrets are required to build. Register the pushed reference with the controller
(`POST /api/images`), then distribute it with `POST /api/images/:id/pull`.
