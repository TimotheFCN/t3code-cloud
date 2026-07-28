# Phase 2 — Docker Driver and Base Image

## Prompt

> Build the `t3env` base image and the agent's docker driver so a node can run T3 Code environment
> containers with nested Docker. Start by reading `.workspaces/t3-fleet/README.md`,
> `product-brief.md`, `current-state.md` (§2, §5, §10), `architecture.md` (§1–§2, §5),
> `docs/fleet/architecture.md` (components, image updates, machine provisioning), and every
> `*.handoff.md` in that folder. Explore the codebase, write your own plan, and execute. When done
> and validated, write `.workspaces/t3-fleet/02-docker-driver-and-base-image.handoff.md`.

## Goal

The agent can create, start, stop, destroy, exec into, and volume-snapshot an environment
container on its node, and the container is a genuinely capable Linux workspace: the T3 server
runs, provider CLIs are on PATH, and an inner Docker daemon works so `docker run hello-world` and
compose stacks succeed inside. The image is reproducible from a Dockerfile in the fleet repo.

## Scope

- **`t3env` image** (`fleet/image/`): Ubuntu LTS, Node 24, the `t3` npm package pinned, provider
  CLIs pinned (`codex`, `@anthropic-ai/claude-code`, `cursor-agent`, `opencode` — see
  `architecture.md` §7 Q3), `tailscale`/`tailscaled` installed (joined in phase 4), git, gh,
  ripgrep, build tools, docker CLI + compose, and an entrypoint that this phase keeps minimal
  (start inner dockerd, start `t3 serve` bound per `T3CODE_*` env). A build script tags and pushes
  to a configurable registry.
- **Volume layout**: one named volume per environment holding the home directory, with the inner
  Docker data root and `T3CODE_HOME` inside it, per the durability contract in
  `docs/fleet/architecture.md` §Image Updates. Decide the exact mount layout and document it.
- **Docker driver** in the agent implementing the phase-1 interface: sysbox runtime
  (`--runtime=sysbox-runc`), volume creation/reuse, container lifecycle, `exec` with output
  capture, `snapshotVolume` (local tarball with retention), and container labels tying resources
  to environment ids for crash-safe reconciliation (agent restart must re-adopt running
  environments).
- **Controller image registry model**: the `images` table, a "current" image setting, and pull
  orchestration through the agent.
- Decide and document: dockerode vs shelling to the docker CLI; how the driver behaves when sysbox
  is absent (fail with a clear diagnostic — do not silently fall back to privileged).

Out of scope: cloning/bootstrap/T3 auth (phase 3), tailnet join (phase 4), credential injection
(phase 5), recreate-on-update flow (phase 7), join script installing sysbox (phase 8).

## Guidelines

- Sysbox is what makes inner Docker safe; never require `--privileged`.
- Reconciliation over bookkeeping: derive observed state from Docker labels, not from trusting the
  DB. The DB stores desired state.
- Keep image contents boring and pinned; every binary version is an explicit ARG.

## Validation

- Automated: driver tests against a real local Docker when available (guarded/skipped otherwise):
  full lifecycle, label reconciliation after agent restart, exec round-trip, snapshot/restore of a
  volume. Image build succeeds in CI conditions (no secrets required).
- Manual on a sysbox-capable host: create an environment container, `docker run hello-world`
  inside it, run a small compose stack inside it, verify `t3 serve` starts and serves its web UI
  on the mapped port, stop/start and confirm the volume persists.
- If no sysbox host is available in your execution environment, validate everything except the
  sysbox runtime flag against plain Docker, and state precisely in the handoff what remains to be
  verified on real hardware.
- Automated coverage required for: reconciliation (adopting/orphaning containers by label).
