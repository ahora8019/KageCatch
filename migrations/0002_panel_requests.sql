-- Durable, idempotent group-panel requests. This table is independent of encrypted Telegram sessions.
CREATE TABLE IF NOT EXISTS panel_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    source_message_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'closed', 'expired')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
    panel_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    last_error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_panel_requests_pending
    ON panel_requests(status, created_at);

CREATE INDEX IF NOT EXISTS idx_panel_requests_owner_chat
    ON panel_requests(owner_id, chat_id, created_at);
