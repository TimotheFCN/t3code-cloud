# Phase 7 — Lifecycle Policies and Image Updates

## Prompt

> Implement idle suspend and dashboard wake, and the image-update flow: recreate-on-latest with
> the same volume, pre-update snapshots, and rollback. Start by reading
> `.workspaces/t3-fleet/README.md`, `product-brief.md` (clarification 2 especially),
> `current-state.md` (§2, §4), `architecture.md` (§3–§6), `docs/fleet/architecture.md`
> (lifecycle, image updates and data durability), and every `*.handoff.md` in that folder.
> Explore the codebase, write your own plan, and execute. When done and validated, write
> `.workspaces/t3-fleet/07-lifecycle-policies-and-image-updates.handoff.md`.

## Goal

Environments stop consuming resources when idle and come back on demand with the same URL and
state; and the fleet's core maintenance promise works: updating the base image recreates
containers while workspaces, T3 state (including pairing), inner-Docker data such as a provisioned
Supabase database, and the tailnet identity all survive — with a snapshot to roll back to if an
update goes wrong.

## Scope

- **Idle detection**: derive activity from phase 3's status polling (active turns, attached
  terminals — verify what the orchestration snapshot exposes and document the exact idle
  predicate); per-environment idle policy (duration, disabled) with a fleet default.
- **Suspend**: stop the container, retain volume and tailnet device, mark suspended, optional
  `git push` to a configured backup remote before stopping (spec §Machine Provisioning); events
  logged.
- **Wake**: dashboard/API action starts the container; entrypoint's rejoin path (phase 4) restores
  the same URL; document that paired clients auto-reconnect. Expose wake state honestly in the
  dashboard ("waking", with recent logs on failure).
- **Image update**: an "update to current image" action per environment and a bulk "update all
  outdated" — sequence per environment: snapshot volume (phase 2's `snapshotVolume`, with
  retention policy) → stop → recreate container from new image with same volume → health check →
  mark updated; on failed health check, offer rollback (restore snapshot + previous image).
  Setup hooks re-run on recreate (phase 3's convention).
- **Dashboard additions**: suspend/wake/update controls on the environment detail view, outdated
  indicators and bulk update on the images view, idle-policy editing.
- Decide and document: snapshot retention (count/age), health-check definition for "update
  succeeded".

Out of scope: inner-Docker container state snapshotting (open question — v1 lets services
cold-start), scheduled/automatic updates (operator-triggered only in v1).

## Guidelines

- The durability contract is the product promise this phase proves: test it with real data (an
  actual inner-Docker volume with content), not just file markers.
- T3 migrations are forward-only (`current-state.md` §2) — this is _why_ the pre-update snapshot
  exists; rollback must restore both volume and image tag together.
- Suspend must never race a create/update in progress; serialize per-environment operations in
  the controller.

## Validation

- Automated: idle-predicate unit tests; per-environment operation serialization; update-sequence
  reconciliation across a simulated controller restart mid-update; snapshot retention.
- Manual (the critical one): create an environment, start a Supabase stack (or any inner compose
  stack with a database) and write data; update the base image to a newly built tag; verify the
  workspace, chat history, pairing, URL, and the database contents all survive; then force a
  failed update and verify rollback restores the pre-update state. Also: let an environment idle
  past its policy, verify suspend; wake it from the dashboard and reconnect a previously paired
  browser.
- Automated coverage required for: update sequencing (snapshot-before-stop ordering) and rollback.
