# Feature workspace templates

Generic skeletons for every file in `.workspaces/<feature-name>/`. Replace the
bracketed placeholders; drop sections that genuinely do not apply. `<ws>` means
`.workspaces/<feature-name>`.

## README.md

```markdown
# [Feature Name]

## Goal

[2–4 sentences: what is being built and for whom.]

The guiding principle:

> [One-sentence product north star.]

Priorities, in order: (1) […], (2) […], (3) […].

## Documents in this folder

| File               | Content                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `product-brief.md` | The source product requirements (authoritative for behavior and scope)     |
| `current-state.md` | Factual analysis of the existing codebase — read before designing anything |
| `architecture.md`  | Domain model, lifecycle, security model, decisions made                    |
| `01-…` → `NN-…`    | Phase plans. Each has an embedded prompt, goal, scope, and validation      |
| `*.handoff.md`     | Written by each phase's agent when its phase ships                         |

## Order of execution

Each phase is fully implemented, validated, and shipped before the next one starts:

1. `01-<name>.md` — [one-line summary]
2. `02-<name>.md` — [one-line summary]
   …

[Dependency graph: which phases are strictly sequential, which depend only on
which, which may be reordered. "Do not start a phase while its dependencies
are unshipped."]

## Global instructions (apply to every phase)

- **Context handoff.** Agents run independently and have no memory of previous
  phases. Before starting, read this README, `product-brief.md`,
  `current-state.md`, `architecture.md`, and every `*.handoff.md` in this
  folder. When your phase is complete and validated, write
  `NN-<name>.handoff.md` next to your plan file: what changed,
  schema/infrastructure/env additions, decisions made, gotchas, and anything
  later phases need. Be concrete — the next agent has zero context beyond
  these files.
- **Explore first.** The plans are goal-focused, not exhaustive. Explore the
  codebase, build your own detailed plan and todos, then execute.
  `current-state.md` gives you the map, not the territory.
- **Read the repo guides.** [List the repo's `AGENTS.md`/contributor docs] are
  authoritative for commands, code style, and workflows.
- **[Top priority].** [E.g. security: the authorization pattern every surface
  must use; data-exposure rules; anti-enumeration. Point into architecture.md.]
- **Respect the architecture decisions.** `architecture.md` records decisions
  made deliberately. If you believe one is wrong, say so in your handoff with
  reasoning — do not silently deviate. Open questions marked "implementation
  may decide" may be resolved by you; otherwise choose the recommended default
  and flag it.
- **No regressions.** Existing flows keep working: [name them explicitly].
- **[Project invariants.]** [Schema-change workflow, design-system rules, copy
  language, "logic lives where" rules… — lifted from the repo's own guides.]
- **Environments.** New infrastructure (env vars, buckets, queues, cron,
  third-party console steps) must be declared for every environment; document
  required manual provisioning in your handoff.
- **Validation before handoff.** [The project's check/test/build commands],
  and manual verification of the new flows in dev. Security-critical paths get
  automated tests. State in the handoff what was validated and how.
- **Cleanup is part of the job.** Remove dead code and dead config as surfaces
  are replaced.
```

## product-brief.md

```markdown
# [Feature Name] — Product Brief

This is the authoritative product requirements document, reproduced from the
original feature pitch ([note anything stripped, e.g. the pitch's
planning-request framing — the planning output is this workspace]). Where
`architecture.md` records a deliberate deviation from this brief,
`architecture.md` wins — deviations are explicit and justified there.

## Post-pitch clarifications (from the product owner — same authority as the pitch)

1. [Clarification…]

---

[The brief, verbatim.]
```

## current-state.md

```markdown
# Current-State Analysis

Factual map of the existing systems this feature touches. Verified against the
codebase on the `[branch]` branch ([month year]). File paths are relative to
`[root]` unless prefixed. Always re-verify details before building on them —
this document orients, it does not replace exploration.

## 1. [System area]

- [Verified facts: versions, file paths, table names, patterns in use,
  notable absences ("no X exists today").]

## 2. [System area]

…

## N. Gaps summary (what the feature must add)

- [Everything required by the brief that does not exist yet.]
```

## architecture.md

```markdown
# Architecture — [Domain Model, …]

Decisions in this document were made deliberately after analyzing the codebase
(`current-state.md`) and the requirements (`product-brief.md`). Phases must
follow them unless their handoff documents a justified deviation. §Open
questions lists what is still undecided and who decides.

## 1. Domain model

| Concept | Backing | Meaning |
| ------- | ------- | ------- |

[Call out load-bearing distinctions explicitly.]

## 2. Access / security model

[Who reads/writes what; the authorization pattern; attack vectors and
answers; data-exposure rules.]

## 3. [Lifecycle / state machines]

## N-2. Schema-change map (indicative — each phase generates its own migrations)

## N-1. Open questions

**Product decisions (user must confirm; recommended defaults in bold):**

1. [Question — **recommended default**.]

**Decided (see §… and phase files):** […]

**Implementation may decide (record in handoff):** […]

## N. Journey coverage (sanity map)

| Journey / edge case | Covered by |
| ------------------- | ---------- |
```

## NN-\<name\>.md (phase plan)

```markdown
# Phase N — [Title]

## Prompt

> [One- to three-sentence mission.] Start by reading
> `<ws>/README.md`, `product-brief.md` (§[relevant]),
> `current-state.md` (§[relevant]), `architecture.md` (§[relevant]), and every
> `*.handoff.md` in that folder. [Any external docs to read before designing.]
> Explore the codebase, write your own plan, and execute. When done and
> validated, write `<ws>/NN-<name>.handoff.md`.

## Goal

[One paragraph: what is true for users when this phase ships.]

## Scope

- **[Deliverable]**: [behavior, constraints, pointers to existing patterns to
  reuse. Where a choice is delegated: "decide X and document it".]
- …

Out of scope: [excluded pieces, each pointing at the phase that owns it].

## Guidelines

- [Phase-specific gotchas, patterns to reuse, protections not to weaken.]

## Validation

- [Automated commands: check, test, build…]
- Manual: [the flows to verify by hand, end to end].
- Automated coverage for: [the paths that must have tests —
  security-critical always].
```

## NN-\<name\>.handoff.md

```markdown
# Phase N Handoff — [Title]

Status: shipped on `[branch]`. [Validation summary: which commands pass.]
Paths below are relative to `[root]` unless noted.

## What changed

### [Area]

- [Concrete changes with file paths. Mark delegated **decisions** and why.
  Record behavior changes that reach beyond this phase.]

### [Gotcha discovered]

[Anything surprising the next agents must know.]

## Tests added

- [Test files and what they prove.]

## Validation performed

- [Commands run, manual flows verified and how, anything NOT testable in this
  environment that must be verified later (say where).]

## For later phases (especially NN-<name>)

- [Hooks, reusable helpers, constraints, warnings — addressed to the specific
  phases that build on this one.]
```
