# Phase 4 — Tailscale Networking

## Prompt

> Make every environment its own tailnet device with an automatically issued HTTPS URL: controller
> mints tagged auth keys through a Tailscale OAuth client, the container joins the tailnet in its
> entrypoint and publishes T3 with `t3 serve --tailscale-serve`, and destroy deletes the device.
> Start by reading `.workspaces/t3-fleet/README.md`, `product-brief.md`, `current-state.md`
> (§2, §6), `architecture.md` (§2, §4–§6), `docs/fleet/architecture.md` (networking, lifecycle),
> and every `*.handoff.md` in that folder. Also read Tailscale's current documentation for OAuth
> clients, auth keys, device API, ACL tags, and `tailscale serve`. Explore the codebase, write
> your own plan, and execute. When done and validated, write
> `.workspaces/t3-fleet/04-tailscale-networking.handoff.md`.

## Goal

After this phase there is no port mapping and no plaintext HTTP: an environment is created and
becomes reachable at `https://env-<id>.<tailnet>.ts.net/` from any of the operator's tailnet
devices, with a publicly trusted certificate, and keeps that exact URL across restarts, suspends,
and image updates. Pairing links from phase 3 now use the tailnet URL.

## Scope

- **Controller tailnet integration**: operator configures a Tailscale OAuth client (stored via the
  vault seam); the controller mints per-environment, pre-authorized, tagged auth keys
  (`tag:t3-env`) at create time and deletes the device via the Tailscale API at destroy time.
  Handle the device-id discovery (map hostname → device after first join).
- **Entrypoint tailnet join**: start `tailscaled` with its state directory on the environment
  volume (stable identity — see the durability contract), join with the minted key and hostname
  `env-<id>`, then run `t3 serve --tailscale-serve` (see `current-state.md` §6 for the flag and
  env equivalents). Support userspace-networking mode when no TUN device is available and
  document which mode sysbox containers end up using.
- **Endpoint switch**: environment records now carry the MagicDNS HTTPS URL as their endpoint;
  phase 3's pairing links and status polling use it. Remove the node-port mapping path.
- **Node/controller tailnet posture**: agents reach the controller via its tailnet name; document
  (in `fleet/deploy/`) the recommended ACL policy for `tag:t3-controller`, `tag:t3-node`,
  `tag:t3-env` exactly as scoped in `docs/fleet/architecture.md` §Networking.
- Decide and document: auth-key TTL/reuse settings; whether status polling goes over the tailnet
  or stays node-local via the agent; behavior when Tailscale Serve certificate issuance is slow
  (create should report "waiting for cert", not fail).

Out of scope: Headscale support (deferred), vault generalization (phase 5), wake UX (phase 7).

## Guidelines

- Device identity lives on the volume; never mint a second key for an environment that already has
  state — rejoin must reuse it. Test this explicitly.
- The OAuth client secret and minted keys are secrets under `architecture.md` §4 rules.
- Ephemeral keys are wrong here (suspended devices must not be garbage-collected); use
  non-ephemeral tagged keys plus explicit API deletion on destroy, as decided in the spec.
- Do not build any Tailscale-specific behavior into the controller's environment model beyond
  "endpoint URL + device id" — the spec keeps transport swappable in principle.

## Validation

- Automated: unit tests for key minting/device deletion against a faked Tailscale API; entrypoint
  logic tests for state-reuse vs first-join paths.
- Manual on a real tailnet (required — this phase cannot be fully validated without one): create
  an environment, open `https://env-<id>.<tailnet>.ts.net/pair#token=...` from another tailnet
  device, verify the certificate is valid and chat works over WSS; restart the container and
  verify same URL; destroy and verify the device disappears from the tailnet admin console. State
  in the handoff exactly what was verified against which Tailscale plan.
- Automated coverage required for: secret handling of the OAuth client and minted keys.
