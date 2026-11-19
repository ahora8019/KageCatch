-- Durable per-group pacing for Control Bot outbound operations.
-- Telegram group rate limits are chat-scoped; this state is separate from the bot-wide gate.
CREATE TABLE IF NOT EXISTS telegram_bot_chat_pacing (
    chat_id TEXT PRIMARY KEY NOT NULL,
    next_allowed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (next_allowed_at_ms >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_chat_pacing_updated
    ON telegram_bot_chat_pacing(updated_at);
