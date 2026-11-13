-- Distributed leases: one active owner per Telegram session.
CREATE TABLE IF NOT EXISTS session_locks (
  session_id TEXT PRIMARY KEY NOT NULL,
  locked_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_session_locks_expiry ON session_locks(expires_at);
