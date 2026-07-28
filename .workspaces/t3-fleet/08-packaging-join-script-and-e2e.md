# Phase 8 — Packaging, Join Script, and End-to-End Validation

## Prompt

> Make T3 Fleet installable by a homelab operator: controller distribution via docker compose, the
> idempotent node join script, operator documentation, and a full end-to-end validation pass of
> every journey in the coverage map. Start by reading `.workspaces/t3-fleet/README.md`,
> `product-brief.md`, `current-state.md`, `architecture.md` (all sections, §6 especially),
> `docs/fleet/architecture.md` (machine provisioning, failure modes, delivery scope), and every
> `*.handoff.md` in that folder. Explore the codebase, write your own plan, and execute. When done
> and validated, write `.workspaces/t3-fleet/08-packaging-join-script-and-e2e.handoff.md`.

## Goal

A person who has never seen this codebase can go from "two Ubuntu boxes and a Tailscale account"
to "creating environments and opening chats" using only `fleet/deploy/` and its docs. v1 is
declared done at the end of this phase, with every coverage-map journey demonstrated or its gap
explicitly documented.

## Scope

- **Controller packaging**: a published/buildable controller image and a `docker-compose.yml`
  (controller + optional `registry:2` sidecar per `architecture.md` §7 Q2), first-run
  initialization (age identity generation, initial config), and a documented backup/restore
  procedure (SQLite file + age identity — test the restore).
- **Join script** (`fleet/deploy/join.sh`): idempotent, non-interactive, flag-driven exactly as
  specced (`docs/fleet/architecture.md` §Machine Provisioning): installs Docker and sysbox when
  missing (decide supported distros — Ubuntu LTS minimum — and document), verifies tailnet
  membership, starts the agent with the join token. Served by the controller so the dashboard's
  copy-paste line works. Structure it so a future cloud-init `user-data` snippet is just "run this
  script" (product clarification 5).
- **Operator docs** (`fleet/deploy/README.md` or `fleet/docs/`): prerequisites (Tailscale account,
  OAuth client setup, ACL example), install, add node, single-box quickstart
  (`architecture.md` §7 Q4), credential import, image building/updating, backup/restore,
  troubleshooting (node offline, cert issuance pending, failed update rollback).
- **End-to-end validation pass**: execute every journey in `architecture.md` §6 on real hardware
  (single node minimum, two nodes if available) and record the results in the handoff — this is
  the v1 acceptance run. Fix what the pass uncovers before shipping.
- **Version/compat statement**: pin and record the tested `t3` package version, sysbox version,
  and protocol version; document the update story for the fleet itself (pull new controller/agent
  images).

Out of scope: cloud-init template itself (deferred; the script is shaped for it), Headscale,
Proxmox/NixOS, GitHub App credentials, client fork patches.

## Guidelines

- Write docs against what actually ships, not the spec's intent — where they diverge, fix the code
  or flag the divergence in the handoff.
- The join script will run on machines you cannot see; fail loudly with actionable messages and
  make re-running always safe.
- Respect the failure-modes table (`docs/fleet/architecture.md` §Failure Modes): the e2e pass
  includes killing the controller, a node, and (if possible) simulating a coordination outage to
  verify the documented behavior.

## Validation

- Automated: shellcheck + bats (or equivalent) tests for join.sh idempotency branches; compose
  config validation; backup/restore round-trip test.
- Manual: the full coverage-map pass on real hardware, from clean machines, following only the
  written docs. A second run of the join script on an already-joined node must be a no-op.
- Automated coverage required for: join-token consumption in the script flow (single-use, expiry,
  bad-token failure).
