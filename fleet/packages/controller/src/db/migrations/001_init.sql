-- Phase 1: control-plane foundations.
-- All timestamps are unix epoch milliseconds (INTEGER).

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  join_state TEXT NOT NULL DEFAULT 'joined',
  credential_hash TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  last_seen_at INTEGER,
  capacity_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE join_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  single_use INTEGER NOT NULL DEFAULT 1,
  used_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  node_id TEXT,
  payload_json TEXT
);

CREATE INDEX idx_events_occurred_at ON events (occurred_at);
