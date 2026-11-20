CREATE TABLE IF NOT EXISTS catch_admission_attempts (
  dedupe_key TEXT PRIMARY KEY NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  attempted_at REAL NOT NULL CHECK (attempted_at >= 0)
);
CREATE INDEX IF NOT EXISTS idx_catch_admission_quota
  ON catch_admission_attempts(user_id, source, attempted_at);
