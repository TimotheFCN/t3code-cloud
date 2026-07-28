# Phase 5 — Credential Vault

## Prompt

> Build Fleet's central credential vault: encrypted at rest with `age`, organized into profiles,
> injecting env-var secrets and provider OAuth file bundles into environments at creation, with a
> `credsync` helper reporting rotated tokens back to the controller. Start by reading
> `.workspaces/t3-fleet/README.md`, `product-brief.md`, `current-state.md` (§2–§3),
> `architecture.md` (§2–§5), `docs/fleet/architecture.md` (credential vault, security model), and
> every `*.handoff.md` in that folder. Explore the codebase, write your own plan, and execute.
> When done and validated, write `.workspaces/t3-fleet/05-credential-vault.handoff.md`.

## Goal

An operator imports credentials once — API keys, a logged-in `~/.claude` / `~/.codex` /
`~/.cursor` / `~/.config/gh` state, a git PAT — into named profiles, and every new environment
created with a profile starts with working provider auth and git access. When a provider CLI
rotates its token inside an environment, the vault copy is updated so the next environment still
works.

## Scope

- **Vault storage**: extend phase 3's encrypted-secrets primitive into the full model of
  `architecture.md` §3 (`profiles`, `secrets`; `age`-encrypted payload file keyed by ref; master
  identity outside the DB). Controller API for profile/secret CRUD and import.
- **Import paths**: env-var secrets entered via API; file bundles imported from a tarball the
  operator produces on a logged-in machine (provide a tiny `fleet vault import` CLI or documented
  `tar` one-liner — decide and document).
- **Injection**: at create, the controller resolves the environment's profile, seals the payload
  to the target agent, and the entrypoint materializes env vars (into the T3 server's process
  environment — see `current-state.md` §2 on env forwarding) and file bundles (into the home
  volume with correct ownership/permissions) before `t3 serve` starts. Exactly once per container
  creation, per the spec.
- **credsync**: a small helper in the image watching the bundle paths (mechanism: implementation
  may decide) and reporting changed files to the controller through the agent channel;
  controller applies last-writer-wins with fingerprints, records `events`, and flags rapid
  conflicting writes for the dashboard. Environments may only affect their own credsync data
  (`architecture.md` §4 invariant 3).
- **Git credentials v1**: PAT or `gh` state as file bundles (decided — see `architecture.md` §7);
  wire a `git` credential path that works for clone at create time too (phase 3's clone should be
  refactored to use the profile when present).

Out of scope: GitHub App short-lived tokens (deferred), secret rotation policies/UI polish
(phase 6 shows state; deferred beyond flags), Tailscale OAuth secret handling (phase 4 owns it,
but migrate it onto the final vault model here if phase 4 shipped a stopgap).

## Guidelines

- Threat model per `docs/fleet/architecture.md` §Security Model: a leaked SQLite file must reveal
  nothing; a compromised environment must expose only its own injected copies.
- Never log payloads, paths are fine. Audit every log line this phase adds.
- Test the real sealing/unsealing flow, not mocks of it.
- Injection failures must fail environment creation loudly and early — a half-credentialed
  environment is worse than none.

## Validation

- Automated: vault round-trip tests (import → store → seal → materialize), profile resolution,
  credsync fingerprint/last-writer-wins logic, permission bits on materialized files, "DB alone
  reveals nothing" test (decrypt fails without the identity file).
- Manual: import a real provider bundle (any one CLI is enough) plus an API key into a profile,
  create an environment with it, verify the provider works in a chat; rotate/touch a bundle file
  inside the environment and verify the vault copy updates and is injected into a newly created
  environment.
- Automated coverage required for: all of §4's secret-handling invariants touched by this phase.
