CREATE TABLE IF NOT EXISTS manual_review_items (
  review_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  spawn_id INTEGER NOT NULL CHECK (spawn_id >= 0),
  anime_name TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  selected_character TEXT,
  CHECK (length(review_id) = 32),
  CHECK (length(user_id) BETWEEN 1 AND 128),
  CHECK (length(anime_name) BETWEEN 1 AND 300)
);

CREATE INDEX IF NOT EXISTS idx_manual_review_user_pending
  ON manual_review_items (user_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_manual_review_expiry
  ON manual_review_items (status, expires_at);
