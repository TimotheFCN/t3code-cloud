-- Phase 3: the controller-side environment model.
--
-- `create_step` persists the create step machine so a controller restarted
-- mid-create resumes where it stopped. `t3_session_ref` points into the
-- age-encrypted vault (never a token). `archive_on_destroy` persists the
-- operator's archive choice so a destroy interrupted by a crash still
-- archives on reconciliation.
CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes (id),
  git_url TEXT NOT NULL,
  git_branch TEXT,
  image_reference TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  create_step TEXT NOT NULL,
  observed_state TEXT NOT NULL,
  host_port INTEGER,
  endpoint_url TEXT,
  t3_session_ref TEXT,
  t3_session_id TEXT,
  t3_environment_id TEXT,
  activity_json TEXT,
  last_status_at INTEGER,
  error TEXT,
  archive_on_destroy INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX environments_node_id ON environments (node_id);

-- Host the controller uses to reach ports published on the node (phase-3
-- node-port endpoints; recorded at agent handshake). Dropped conceptually in
-- phase 4 when per-environment tailnet URLs replace node ports.
ALTER TABLE nodes ADD COLUMN endpoint_host TEXT;
