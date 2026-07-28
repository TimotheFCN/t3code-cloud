---
name: feature-workspace
description: Scaffold a phased agent workspace from a product brief. Turns a feature pitch into a .workspaces/<feature>/ folder with design docs, numbered phase plans with embedded launch prompts, and a handoff protocol so independent agents can ship the feature phase by phase. Use when the user provides a product brief or pitch and asks to plan a feature, create a workspace, split work into phases for agents, or set up specs and prompts for a large feature.
---

# Feature Workspace — phased agent workflow from a product brief

Turn a product brief into a self-contained workspace that lets **independent,
memoryless agents** ship a large feature as a sequence of validated phases. Each
phase is executed by a fresh agent that reads only the workspace files and the
repo, does its own exploration and planning, ships, then writes a handoff for
the next agent.

Two moments where this skill applies:

1. **Scaffolding** (this is the bulk of the work): you receive a product brief
   and produce the whole workspace — design docs, phase plans, prompts.
2. **Running a phase**: an agent is launched with a phase's embedded prompt and
   follows the protocol described in the workspace README.

## Directory layout

```
.workspaces/<feature-name>/
├── README.md              # Goal, doc index, phase order, global instructions
├── product-brief.md       # The source requirements, authoritative for behavior
├── current-state.md       # Factual analysis of the existing codebase
├── architecture.md        # Domain model, decisions, security, open questions
├── 01-<name>.md           # Phase plan (embedded prompt, goal, scope, validation)
├── 02-<name>.md           # …
└── NN-<name>.handoff.md   # Written by each phase's agent when its phase ships
```

The workspace is committed to the feature branch. Design docs land in one
"design" commit; each phase lands in its own commit including its handoff.

## Scaffolding workflow

Work through these steps in order. Templates for every file are in
[templates.md](templates.md).

### Step 1 — Capture the brief as `product-brief.md`

Reproduce the brief **verbatim** — it is the authoritative product document.
Only strip meta-framing that addresses the planning process itself (e.g. "your
task is to produce a plan…", required-output sections); the planning output is
the workspace, not a section of the brief. Add a header stating that where
`architecture.md` records a deliberate deviation, `architecture.md` wins.

If the product owner gives clarifications after the pitch, append them in a
"Post-clarifications" section at the top, marked as having the same authority
as the brief. Number them.

### Step 2 — Analyze the codebase into `current-state.md`

A factual map of every existing system the feature touches: identity, data
model, relevant modules, UI system and reusable patterns, infrastructure,
emails, jobs — whatever applies. Rules:

- **Verified facts only**, with file paths and version numbers. State the
  branch and date it was verified against.
- Organize into numbered sections (`## 1. …`) so phase plans and prompts can
  reference them precisely (`current-state.md §3`).
- End with a **gaps summary**: what the feature must add that does not exist.
- Open with the caveat that the document _orients_ — agents must re-verify
  before building on it. It is a map, not the territory.

This step requires real exploration. Read the code, do not guess.

### Step 3 — Make the architecture decisions in `architecture.md`

This is where design happens once so that eight agents do not re-decide it
eight times. Cover, as applicable:

- **Domain model**: concepts, backing tables/entities, meaning. Call out
  distinctions that are load-bearing (e.g. "the person racing and the account
  managing the registration are distinct and stay distinct").
- **Access/security model**: who may read/write what, the authorization
  pattern every surface must use, attack vectors and their answers,
  anti-enumeration and data-exposure rules.
- **Lifecycle/state machines** the feature introduces.
- **Schema-change map** (indicative, per phase — each phase generates its own
  migrations).
- **Open questions**, split into three buckets:
  1. _Product decisions the user must confirm_ — list each with a
     **recommended default in bold**. Ask the user before finalizing; record
     the outcome.
  2. _Decided_ — pointer to where.
  3. _Implementation may decide_ — explicitly delegated to phase agents, who
     must record their choice in the handoff.
- **Journey coverage map**: a table mapping every user journey and edge case
  from the brief to the phase(s) that cover it. This is the sanity check that
  the phase slicing loses nothing.

State up front that decisions were made deliberately and phases must follow
them unless their handoff documents a justified deviation.

### Step 4 — Slice into phases

- Each phase is **one agent run**: fully implemented, validated, and shipped
  before the next starts. Size accordingly (roughly one coherent subsystem or
  surface per phase).
- Order by dependency; foundations (auth, ownership, core data) first, then
  surfaces, then optional/parallelizable modules. Make the dependency graph
  explicit in the README ("phases 1→4 strictly sequential; 5, 6, 7 depend only
  on 3; …") so independent phases can be reordered.
- Every journey in the coverage map must land in some phase; everything else
  is explicitly out of scope for V1.

### Step 5 — Write the phase plans `NN-<name>.md`

Each plan has five sections — see the template. The critical properties:

- **`## Prompt`** — a blockquoted, self-contained launch prompt. It must work
  when pasted alone into a fresh agent with zero other context: one-sentence
  mission, then "Start by reading `<workspace>/README.md`, `product-brief.md`
  (§X), `current-state.md` (§Y), `architecture.md` (§Z), and every
  `*.handoff.md` in that folder", any external docs to read first, then
  "Explore the codebase, write your own plan, and execute. When done and
  validated, write `<workspace>/NN-<name>.handoff.md`." Reference the specific
  numbered sections relevant to this phase.
- **`## Goal`** — the outcome in user terms, one paragraph. What is true when
  the phase ships.
- **`## Scope`** — bulleted deliverables. Goal-focused, not exhaustive: state
  behavior, constraints, and pointers to existing patterns; leave the how to
  the agent. Where a choice is delegated, say "decide X and document it".
  End with an explicit **out of scope** line pointing at the phases that own
  the excluded pieces.
- **`## Guidelines`** — phase-specific gotchas, patterns to reuse, protections
  not to weaken.
- **`## Validation`** — the exit bar: automated commands, manual flows to
  verify by hand, and which paths need automated test coverage
  (security-critical paths always do).

### Step 6 — Write `README.md`

Goal and priorities, a table describing each document, the execution order
with the dependency graph, and the **global instructions applying to every
phase**. The global instructions must include at least:

- **Context handoff**: agents run independently with no memory. Before
  starting, read the README, the three design docs, and every handoff. When
  done and validated, write `NN-<name>.handoff.md`. Be concrete — the next
  agent has zero context beyond these files.
- **Explore first**: plans are goal-focused, not exhaustive; build your own
  detailed plan before executing.
- **Read the repo guides**: the repo's `AGENTS.md` files stay authoritative
  for commands, code style, and workflows — do not duplicate their content
  into the workspace, reference them.
- **Respect the architecture decisions**; deviations must be justified in the
  handoff, never silent.
- **No regressions**: name the existing flows that must keep working.
- **Validation before handoff**: the project's check/test/build commands plus
  manual verification; state in the handoff what was validated and how.
- **Cleanup is part of the job**: remove code the phase supersedes.
- Project-specific invariants that apply to every phase (derive these from the
  repo's own guides and the architecture doc — e.g. schema-change workflow,
  design-system rules, copy language, security funnel). Do not invent them;
  lift them from what the repo already mandates.

### Step 7 — Review with the user, then commit

Present the open product questions from `architecture.md` §Open questions with
your recommended defaults. After the user confirms, record the decisions and
commit the workspace as the feature's design commit.

## Running a phase

- Launch a fresh agent with the phase's `## Prompt` blockquote, verbatim.
- The agent follows the README protocol: read docs and handoffs → explore →
  plan → execute → validate → write the handoff → commit.
- Never start a phase whose dependencies are unshipped.

## The handoff protocol

Handoffs are the only memory between agents — their quality determines whether
the next phase succeeds. A handoff (`NN-<name>.handoff.md`, template in
[templates.md](templates.md)) records: status and validation summary, what
changed (by area, with file paths), decisions made where the plan delegated
them, gotchas discovered (these are gold — e.g. "the framework's rate limiter
does not apply to server-side API calls"), schema/infrastructure/env additions
and what must be provisioned per environment, tests added, validation
performed (including what could _not_ be tested and must be verified later),
and a "for later phases" section addressed to the specific phases that build
on this one.

## Principles (why the workflow is shaped this way)

- **Design once, execute many**: all cross-phase thinking lives in the three
  design docs; phase agents decide implementation details only.
- **Docs orient, code decides**: every analysis document tells agents to
  re-verify; stale facts are worse than absent ones.
- **Goal-focused plans**: over-specified plans rot and rob the agent of better
  solutions found during exploration; under-specified plans lose product
  intent. State behavior and constraints, delegate mechanism.
- **Explicit delegation**: every choice is either decided in
  `architecture.md`, delegated with "decide and document", or listed as an
  open question with an owner. Nothing is implicitly up for grabs.
- **Handoffs over memory**: assume the next agent knows nothing you did not
  write down.
