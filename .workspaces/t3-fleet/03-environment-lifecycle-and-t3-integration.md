# Phase 3 — Environment Lifecycle and T3 Integration

## Prompt

> Wire the full environment lifecycle into the controller: create (clone, setup hook, `t3 project
add`, serve), bootstrap a stored admin session per environment, poll status, mint pairing links
> on demand, and destroy cleanly. Start by reading `.workspaces/t3-fleet/README.md`,
> `product-brief.md`, `current-state.md` (§2–§5), `architecture.md` (§2–§6),
> `docs/fleet/architecture.md` (lifecycle, components), and every `*.handoff.md` in that folder.
> Explore the codebase, write your own plan, and execute. When done and validated, write
> `.workspaces/t3-fleet/03-environment-lifecycle-and-t3-integration.handoff.md`.

## Goal

An operator can ask the controller (via its HTTP API — the dashboard arrives in phase 6) for a new
environment for a git URL, and get back a running T3 server with the project registered, an
"open chat" pairing URL that works in a browser, live status in the inventory, and a destroy
operation that leaves nothing behind. This is the phase where Fleet becomes T3-aware.

## Scope

- **Create flow** (`docs/fleet/architecture.md` §Environment Lifecycle steps 1–6, minus the
  tailnet parts which phase 4 adds): scheduler picks a node (explicit choice + simple bin-packing
  on free memory), entrypoint clones the repo/branch, runs the project's setup hook when present
  (decide the hook convention — file name and location — and document it), `t3 project add`, then
  `t3 serve`. Until phase 4, environments are reachable via a node-port mapping; structure the
  endpoint handling so phase 4 swaps in tailnet URLs cleanly.
- **Bootstrap credential**: after health, exec `t3 auth session issue --json` (admin scopes — see
  `current-state.md` §3), store the session token via the vault seam (plaintext-at-rest is
  unacceptable; if phase 5 has not landed, build the minimal encrypted-secrets primitive it will
  extend, per `architecture.md` §4).
- **Status**: poll `GET /.well-known/t3/environment` (liveness/identity) and
  `GET /api/orchestration/snapshot` (activity) with the stored session; persist observed state and
  expose it in the inventory API. Activity data must be sufficient for phase 7's idle detection.
- **Pairing links**: a controller operation that mints a one-time pairing credential over
  `POST /api/auth/pairing-token` and returns the ready `/pair#token=...` URL. Never store minted
  links (`architecture.md` §4).
- **Destroy**: optional final-work archive (uncommitted diff tarball into controller storage),
  stop, delete volume, revoke the controller-held session (`t3 auth session revoke` or the HTTP
  revoke route), mark destroyed. Tailnet device deletion is added in phase 4.
- **Events**: record create/destroy/status transitions in the `events` log.

Out of scope: tailnet join and HTTPS URLs (phase 4), credential profiles and provider secrets
(phase 5), dashboard (phase 6), suspend/wake and image updates (phase 7).

## Guidelines

- The controller must survive its own restart mid-create: model create as steps with persisted
  progress and make reconciliation converge (re-runnable steps, not a fragile saga).
- Exec is bootstrap-and-break-glass only; all steady-state interaction is HTTP
  (`architecture.md` §2).
- Verify against a real `t3` binary from npm inside the container — do not stub T3's CLI output
  formats; parse `--json` output.
- Two environments for the same project must not interfere (separate volumes, separate clones,
  separate T3 state) — this is the product's core promise.

## Validation

- Automated: integration test with controller + agent + real Docker (guarded as in phase 2)
  driving create → status → pairing link → destroy against a real `t3env` container; unit tests
  for scheduler placement and create-step reconciliation after a simulated controller crash.
- Manual: create two environments for the same repo on one node, open a chat in each via their
  pairing URLs from a browser, verify they are fully independent, destroy both, and confirm no
  containers, volumes, or sessions remain.
- Automated coverage required for: session-token storage (no plaintext at rest), pairing-link
  minting authorization path.
