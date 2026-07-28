# Phase 6 — Dashboard

## Prompt

> Build the Fleet dashboard: a React + Vite management UI served by the controller, covering
> nodes, environments (create, open chat, destroy), images, vault profiles, and the activity log.
> Start by reading `.workspaces/t3-fleet/README.md`, `product-brief.md`, `current-state.md`
> (§1, §10), `architecture.md` (§1–§4, §6–§7), `docs/fleet/architecture.md` (components,
> lifecycle, delivery scope), and every `*.handoff.md` in that folder. Explore the codebase —
> including `apps/web` for UI conventions worth borrowing, without importing from it — write your
> own plan, and execute. When done and validated, write
> `.workspaces/t3-fleet/06-dashboard.handoff.md`.

## Goal

The centralized UI from the product pitch exists: an operator opens
`https://fleet.<tailnet>.ts.net/`, sees every node and environment with live status, creates an
environment for a project in a form (git URL, branch, node or auto, profile), clicks "Open chat"
and lands in a working T3 session, and can destroy environments and inspect recent activity. The
dashboard is the primary interface; the HTTP API remains fully capable without it.

## Scope

- **Dashboard app** (`fleet/packages/dashboard`): React + Vite, typed API client generated from or
  sharing the `shared` schemas, built output served by the controller process (single port, no
  separate web server).
- **Views**: nodes (inventory, health, join-token issuance with copy-paste script line);
  environments (list with status/node/image/profile, create form, detail view with events, "Open
  chat", destroy with confirmation); images ("current" tag management, which environments are
  outdated); vault (profiles and secret metadata — names, kinds, updated-at, credsync flags;
  never secret values); activity (the `events` log).
- **Open chat**: calls the phase-3 pairing-link operation and opens the returned
  `/pair#token=...` URL in a new tab. Links are minted per click, never displayed for reuse.
- **Live updates**: status changes reflect without manual refresh (SSE or WS from the controller —
  implementation may decide).
- **Auth posture**: per `architecture.md` §7 Q1 default — tailnet ACLs only, no login screen; keep
  a seam where an auth layer could be added.
- Decide and document: component library (or none), state management approach.

Out of scope: suspend/wake and image-update actions (phase 7 adds them to the environment detail
and images views), packaging (phase 8).

## Guidelines

- This is an operator tool: information density and honesty over polish. Show real errors
  (create-step failures, unreachable nodes) verbatim with context.
- Do not import from `apps/web` or `@t3tools/*` (hard boundary from `architecture.md` §1); do
  borrow visual/UX conventions by reading it.
- Every dashboard action must map to a controller API call that works from `curl` too — no
  dashboard-only endpoints with hidden semantics.

## Validation

- Automated: component tests for the create form and environment list state handling; API-client
  contract tests against the controller's schemas; controller serves the built dashboard
  (integration smoke).
- Manual: full operator walkthrough against a real controller + node — join a node from the UI's
  script line, create an environment, watch status progress live, open a chat, destroy it, and
  review the activity log. Verify the UI over the tailnet URL, not localhost.
- Automated coverage required for: any endpoint added for the dashboard (same authz rules as the
  rest of the API).
