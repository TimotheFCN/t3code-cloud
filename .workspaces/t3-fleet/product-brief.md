# T3 Fleet — Product Brief

This is the authoritative product requirements document, reproduced verbatim from the product
owner's messages (planning-process framing stripped). Where `architecture.md` or the committed
architecture spec (`docs/fleet/architecture.md`) records a deliberate deviation from this brief,
those documents win — deviations are explicit and justified there.

## The pitch

> My goal is to allow managing t3 code instances using something like docker or kubernetes, on the
> fly, to allow working on the same project in different independent environments (ex: running
> services like supabase).
>
> There would be a centralized ui to manage all the running environments, and open chats in any of
> them.
>
> We would manage the base image in a central place so that we can easily update the bundled
> dependencies (ex: codex, claude code and cursor, git, etc). Each environment would be it's own
> linux thing where the agent can do whatever it needs.
>
> Ideally, we would also manage all credentials centrally (like some kind of vault for all the
> different providers authentication, git, etc)
>
> [The solution should be implementable] in a way that doesn't break too much the codebase so we
> can keep our fork in sync with upstream changes.

## Post-pitch clarifications (from the product owner — same authority as the pitch)

1. **Audience**: "This is meant to be self-hosted for advanced homelab enthousiasts."
2. **Data durability across image updates**: after reviewing the recreate-with-volume model —
   "It's ok if we loose installed packages from apt as long as the working directories are kept,
   that's fine."
3. **No phased rollout**: "We don't want to implement it in a phased rollout, we want to reach a
   working state directly." (The numbered phases in this workspace are an _execution_ device for
   agents, not a product rollout — the product ships as one working v1.)
4. **Fork policy**: "The zero-fork model is a bit strict. Maintaining a fork isn't out of the
   equation if it brings actual benefits and does not diverge too much from the upstream code
   making it easy to maintain."
5. **Node deployment**: "Keep node deployment to a simple script for now (no proxmox or nixos). We
   will add a cloud-init solution later, that's a great idea so keep it easily doable."
6. **Networking**: "We want to avoid maintaining a domain and certificates. Having this as a
   requirement makes the barrier of entry a bit too high. Find a simpler solution which stays clean
   (it can be just using tailscale everywhere, is this is mostly supported now, or having some kind
   of control plane like t3 connect)." — Resolved in the architecture spec: Tailscale everywhere;
   each environment is its own tailnet device with MagicDNS HTTPS.

## Approved architecture

The product owner reviewed and approved the architecture spec committed at
`docs/fleet/architecture.md` (branch `fleet/architecture-spec`). That spec is the authoritative
system design for this feature; this workspace's `architecture.md` adds the implementation-level
decisions on top of it.
