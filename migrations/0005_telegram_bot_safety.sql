-- Durable, singleton safety state for the Control Bot Bot API identity.
-- This is separate from per-user Telethon/MTProto safety state.
CREATE TABLE IF NOT EXISTS telegram_bot_safety (
    singleton_id TEXT PRIMARY KEY NOT NULL CHECK (singleton_id = 'control-bot'),
    paused_until_ms INTEGER NOT NULL DEFAULT 0 CHECK (paused_until_ms >= 0),
    next_allowed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (next_allowed_at_ms >= 0),
    pause_reason TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO telegram_bot_safety (singleton_id)
VALUES ('control-bot')
ON CONFLICT(singleton_id) DO NOTHING;
