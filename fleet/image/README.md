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

| Path                 | Contents                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `/root/.t3`          | `T3CODE_HOME`: threads, sessions, project registry, auth database |
| `/root/.docker-data` | inner Docker data root (`/etc/docker/daemon.json`)                |
| `/root/workspace`    | project clone (created in phase 3)                                |
| `/root/.tailscale`   | tailscaled state — stable device identity (created in phase 4)    |
| `/root/.claude` etc. | provider CLI state, injected/synced by the vault (phase 5)        |

Everything **outside** `/root` — including `apt` installs made during a session — is legitimately
lost when the container is recreated with a newer image. That is why every binary in this image
installs to `/usr/local`, never `/root`: a named volume is seeded from the image's `/root` on
first use and then persists, so anything under `/root` in the image would go stale after updates.

The inner Docker data root deliberately lives on the volume (a real host filesystem), which both
persists inner images/containers and sidesteps overlayfs-on-overlayfs; sysbox's special handling
of `/var/lib/docker` is not needed.

## Entrypoint (phase-2 minimal)

`entrypoint.sh` starts the inner `dockerd` (waits up to 30s for the socket; warns and continues
without it when the runtime cannot support it, e.g. plain `runc` in development), then runs
`t3 serve` configured purely through `T3CODE_*` env vars. Image defaults:

```text
T3CODE_HOST=0.0.0.0  T3CODE_PORT=3773  T3CODE_HOME=/root/.t3  T3CODE_NO_BROWSER=1
```

`T3ENV_SKIP_DOCKERD=1` skips the inner daemon (useful in tests). Later phases extend the
bootstrap sequence (tailnet join, credentials, clone, setup hook, `t3 project add`).

## Building and pushing

```bash
./build.sh                                        # t3env:dev, local only
TAG=0.1.0 REGISTRY=registry.lan:5000 PUSH=1 ./build.sh
BUILD_ARGS="--build-arg T3_VERSION=0.0.30" ./build.sh
```

No secrets are required to build. Register the pushed reference with the controller
(`POST /api/images`), then distribute it with `POST /api/images/:id/pull`.
