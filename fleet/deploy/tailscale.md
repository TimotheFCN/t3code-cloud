# Tailscale setup for T3 Fleet

Fleet's networking is **Tailscale everywhere** (`docs/fleet/architecture.md` §Networking): every
environment is its own tailnet device named `env-<id>`, reachable at
`https://env-<id>.<tailnet>.ts.net/` with an automatically issued, publicly trusted certificate.
There is no port mapping, no reverse proxy, and no PKI to manage. This document is the one-time
tailnet setup an operator performs.

## Prerequisites

On your tailnet (admin console → DNS):

1. **MagicDNS** must be enabled.
2. **HTTPS certificates** must be enabled (this is what lets each device fetch a Let's Encrypt
   certificate for its `*.ts.net` name).

Hosts:

- The **controller host** must be a tailnet member with MagicDNS resolution working (the
  controller reaches environments through their `*.ts.net` names for health checks, status
  polling, and pairing-link minting). Bind the API to the tailnet interface via
  `FLEET_CONTROLLER_HOST`.
- **Node hosts** must be tailnet members so their agents can dial the controller's tailnet name
  (`FLEET_AGENT_CONTROLLER_URL=https://<controller>.<tailnet>.ts.net` or the raw tailnet IP).
  Environments themselves join with controller-minted keys — nothing to do per node.

## 1. Define the tags

Add the three Fleet tags to your tailnet policy file (admin console → Access controls):

```jsonc
{
  "tagOwners": {
    "tag:t3-controller": ["autogroup:admin"],
    "tag:t3-node": ["autogroup:admin"],
    "tag:t3-env": ["autogroup:admin"],
  },
}
```

Tag the controller host with `tag:t3-controller` and each node host with `tag:t3-node` when they
join the tailnet (e.g. `tailscale up --advertise-tags=tag:t3-node`). Environment devices get
`tag:t3-env` automatically from the minted auth keys.

## 2. Recommended ACL policy

Environments accept traffic only from the operator's devices and the controller; they can
initiate nothing; nodes only dial the controller. With default-deny ACLs (remove the default
`allow all` rule), the Fleet-relevant rules are:

```jsonc
{
  "acls": [
    // Operator devices open environment chats over HTTPS/WSS.
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:t3-env:443"] },

    // Operator devices use the controller dashboard/API (default port 9400).
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:t3-controller:9400"] },

    // Node agents dial the controller's WebSocket endpoint (outbound only).
    { "action": "accept", "src": ["tag:t3-node"], "dst": ["tag:t3-controller:9400"] },

    // The controller health-checks and polls environments and mints pairing
    // links over their tailnet HTTPS endpoints.
    { "action": "accept", "src": ["tag:t3-controller"], "dst": ["tag:t3-env:443"] },

    // Deliberately absent: any rule with "src": ["tag:t3-env"] — environments
    // cannot reach each other, the nodes, or the controller.
  ],
}
```

Tailnet ACLs are the access control for the v1 dashboard/API — do not expose the controller port
beyond the tailnet.

## 3. Create the OAuth client

Admin console → **Trust credentials** → **Credential** → **OAuth** (requires an Owner/Admin/IT
admin role):

- Scopes: **`auth_keys` (write)** — mint per-environment auth keys — and **`devices:core`
  (write)** — list devices after join and delete them on destroy.
- Tags: **`tag:t3-env`**. An OAuth client can only mint keys carrying its own tags (or tags owned
  by them), so this selection is what confines Fleet-minted keys to environment devices.

The client secret (`tskey-client-…`) is shown exactly once — hand it straight to the controller.

## 4. Configure the controller

```bash
curl -X PUT http://<controller>:9400/api/settings/tailscale \
  -H 'content-type: application/json' \
  -d '{"clientId": "<oauth client id>", "clientSecret": "<oauth client secret>", "tag": "tag:t3-env"}'
```

The secret is encrypted into the controller's vault (only a reference rests in SQLite) and is
never returned by any endpoint; `GET /api/settings/tailscale` shows `{configured, clientId, tag}`
only. `tag` is optional and defaults to `tag:t3-env` — if you use a different tag, it must be one
the OAuth client owns. Reconfiguring replaces the stored secret.

Environment creation fails with a clear error until this is configured.

## How Fleet uses the tailnet (for reference)

- **Create**: the controller mints a **single-use, pre-authorized, non-ephemeral** auth key
  tagged `tag:t3-env` (expiry `FLEET_CONTROLLER_TS_AUTHKEY_TTL_SECONDS`, default 3600 — it only
  needs to outlive image pull + container start). The container joins as `env-<id>` with
  `tailscaled` state on the environment volume, and `t3 serve --tailscale-serve` publishes the
  T3 server at `https://env-<id>.<tailnet>.ts.net/`. After the device appears, the key is deleted
  everywhere. Non-ephemeral is deliberate: ephemeral devices would be garbage-collected while an
  environment is suspended, losing its URL.
- **Restart / suspend / image update**: the device identity lives on the volume, so the
  environment keeps the exact same name and URL for life; a suspended environment's device simply
  shows offline. No key is ever minted again for an existing environment.
- **Destroy**: the controller deletes the device through the Tailscale API — destroyed
  environments disappear from your tailnet.
- The first HTTPS request after the very first join can take up to a minute while Tailscale Serve
  obtains the certificate; the controller reports this as a status detail instead of failing.
  Certificates persist on the volume afterwards.
- Inside the container, `tailscaled` uses kernel TUN networking when `/dev/net/tun` is available
  (sysbox exposes it) and falls back to `--tun=userspace-networking` otherwise (e.g. plain runc
  in development). Inbound serving behaves the same in both modes.

## Plan limits

Each live environment consumes one tailnet device. The free plan's allowance (currently 100
devices) is ample for a homelab fleet; destroyed environments free their device immediately.
Headscale is not supported in v1 (automatic `ts.net` HTTPS certificates are the sticking point).
