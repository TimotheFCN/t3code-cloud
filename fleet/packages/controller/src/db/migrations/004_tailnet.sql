-- Phase 4: per-environment tailnet devices replace node-port endpoints.
--
-- `settings` is a generic key-value store; phase 4 uses it for the Tailscale
-- OAuth client (the secret itself lives in the vault — only its ref rests
-- here). `ts_authkey_ref`/`ts_authkey_id` track the minted, vault-encrypted
-- auth key between mint and first join; both are cleared once the device has
-- joined. `status_detail` carries human-readable progress notes for slow
-- mid-create waits (HTTPS certificate issuance).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE environments ADD COLUMN tailnet_device_id TEXT;

ALTER TABLE environments ADD COLUMN ts_authkey_ref TEXT;

ALTER TABLE environments ADD COLUMN ts_authkey_id TEXT;

ALTER TABLE environments ADD COLUMN status_detail TEXT;

-- The node-port endpoint path is gone: environments are reached over their
-- own tailnet HTTPS URLs, never through ports published on the node.
ALTER TABLE environments DROP COLUMN host_port;

ALTER TABLE nodes DROP COLUMN endpoint_host;
