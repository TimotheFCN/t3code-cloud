# T3 Fleet

## Goal

Build T3 Fleet: self-hosted orchestration of disposable T3 Code environments on homelab machines.
A central controller manages a pool of Linux nodes running environment containers (each one a full
Linux workspace with nested Docker, its own tailnet HTTPS URL, and one T3 server), a dashboard to
create/destroy environments and open chats in one click, one centrally managed base image, and an
encrypted credential vault.

The guiding principle:

> Fleet orchestrates stock T3 Code from the outside — one environment is one T3 server, consumed
> through its CLI and HTTP APIs, never by patching it.

Priorities, in order: (1) the durability and isolation promises (independent environments, data
survives image updates), (2) secret safety, (3) operator simplicity (two Ubuntu boxes + a
Tailscale account must be enough).

## Documents in this folder

| File               | Content                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `product-brief.md` | The source product requirements (authoritative for behavior and scope)                |
| `current-state.md` | Factual analysis of the existing codebase — read before designing anything            |
| `architecture.md`  | Implementation decisions: repo layout, protocol, data model, security, open questions |
| `01-…` → `08-…`    | Phase plans. Each has an embedded prompt, goal, scope, and validation                 |
| `*.handoff.md`     | Written by each phase's agent when its phase ships                                    |

The approved **system design** is `docs/fleet/architecture.md` at the repository root — every
phase reads it in full. This folder's `architecture.md` layers implementation decisions on top.

## Order of execution

Each phase is fully implemented, validated, and shipped before a dependent phase starts:

1. `01-control-plane-foundations.md` — fleet workspace, controller + SQLite, agent join protocol,
   driver interface
2. `02-docker-driver-and-base-image.md` — t3env image, sysbox docker driver, volumes, snapshots
3. `03-environment-lifecycle-and-t3-integration.md` — create/status/pairing/destroy against real
   T3 servers
4. `04-tailscale-networking.md` — per-environment tailnet devices, MagicDNS HTTPS, device
   lifecycle
5. `05-credential-vault.md` — profiles, age-encrypted storage, injection, credsync
6. `06-dashboard.md` — the centralized management UI
7. `07-lifecycle-policies-and-image-updates.md` — idle suspend/wake, recreate-on-latest, rollback
8. `08-packaging-join-script-and-e2e.md` — compose distribution, join.sh, docs, v1 acceptance run

Dependency graph: 1 → 2 → 3 → 4 are strictly sequential. 5 depends on 3 (and folds in 4's secret
stopgap if any). 6 depends on 3 and is extended by 5 and 7 (run it after 5 for full vault views;
its plan tolerates 7 landing later). 7 depends on 4. 8 is last, after all others. Do not start a
phase while its dependencies are unshipped.

## Global instructions (apply to every phase)

- **Context handoff.** Agents run independently and have no memory of previous phases. Before
  starting, read this README, `product-brief.md`, `current-state.md`, `architecture.md`,
  `docs/fleet/architecture.md`, and every `*.handoff.md` in this folder. When your phase is
  complete and validated, write `NN-<name>.handoff.md` next to your plan file: what changed (with
  file paths), schema/infrastructure/env additions and required manual provisioning, decisions
  made where the plan delegated them, gotchas, tests added, validation performed (including what
  could **not** be verified in your execution environment and must be checked on real hardware),
  and notes addressed to the specific later phases that build on yours. Be concrete — the next
  agent has zero context beyond these files.
- **Explore first.** Plans are goal-focused, not exhaustive. Explore the codebase, build your own
  detailed plan and todos, then execute. `current-state.md` gives you the map, not the territory —
  re-verify facts before building on them.
- **Read the repo guides.** The repository's `AGENTS.md` and `.cursor/rules/` are authoritative
  for commands, code style, and workflows. For Effect code, read `.repos/effect-smol/LLMS.md`
  first and use `.repos/effect-smol/` as the idiom reference.
- **Secret safety is the non-negotiable.** Follow `architecture.md` §4 exactly: nothing plaintext
  at rest, nothing in logs, sealed in transit, environments untrusted. Security-critical paths
  always get automated tests.
- **Respect the architecture decisions.** `docs/fleet/architecture.md` and `architecture.md`
  record decisions made deliberately. If you believe one is wrong, say so in your handoff with
  reasoning — do not silently deviate. Questions marked "implementation may decide" are yours to
  resolve and record; for unconfirmed product questions, take the recommended default and flag it
  in the handoff.
- **Hard boundary to upstream.** Everything lives under `fleet/` (plus this workspace). Do not
  modify root workspace files, `apps/*`, `packages/*`, or `infra/*`; do not import `@t3tools/*`
  from fleet code. T3 is consumed via the `t3` CLI and HTTP APIs listed in `current-state.md`
  §2–§5 only.
- **No regressions.** The upstream repo must keep passing its own checks untouched: do not edit
  files outside `fleet/` and `.workspaces/t3-fleet/`. Within Fleet, earlier phases' validated
  flows (node join, environment create/destroy, pairing) must keep working — re-run their key
  tests when you touch shared code.
- **Environments and infrastructure.** New env vars, images, tailnet/ACL requirements, or
  third-party console steps (Tailscale OAuth clients, registries) must be documented in your
  handoff and reflected in `fleet/deploy/` docs when they affect operators.
- **Validation before handoff.** Fleet's own typecheck/lint/tests must pass; run the focused test
  suites for what you touched, plus the manual verification your phase's Validation section
  demands. Real-hardware checks that your execution environment cannot perform (sysbox, a live
  tailnet) must be explicitly listed in the handoff as pending — never silently skipped.
- **Cleanup is part of the job.** Remove stopgaps you supersede (phase 5 absorbs phase 3/4 secret
  primitives; phase 4 removes phase 3's port mapping). Dead code and dead config do not ship to
  v1.
- **Commits.** Each phase lands as its own commit (or small series) on the feature branch,
  including its handoff. The pre-commit hook runs the formatter; markdown must be
  formatter-clean (`./node_modules/.bin/vp check --fix <files>` from the repo root works in this
  environment).
