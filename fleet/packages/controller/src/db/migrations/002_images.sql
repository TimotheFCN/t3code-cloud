-- Phase 2: base image registry.
-- All timestamps are unix epoch milliseconds (INTEGER).

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  digest TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_images_current ON images (is_current) WHERE is_current = 1;
