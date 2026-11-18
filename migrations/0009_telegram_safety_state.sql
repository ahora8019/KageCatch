-- Shared, fail-closed Telegram safety state and per-chat send pacing.
-- This migration is source-only until separately reviewed and explicitly applied.

CREATE TABLE IF NOT EXISTS telegram_safety_state (
  owner_id TEXT PRIMARY KEY NOT NULL,
  security_locked INTEGER NOT NULL DEFAULT 0 CHECK (security_locked IN (0, 1)),
  session_revoked INTEGER NOT NULL DEFAULT 0 CHECK (session_revoked IN (0, 1)),
  lock_reason TEXT,
  flood_wait_until INTEGER NOT NULL DEFAULT 0 CHECK (flood_wait_until >= 0),
  bot_retry_after INTEGER NOT NULL DEFAULT 0 CHECK (bot_retry_after >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS telegram_send_pacing (
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  next_allowed_at INTEGER NOT NULL CHECK (next_allowed_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (owner_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_send_pacing_expiry
  ON telegram_send_pacing (next_allowed_at);
