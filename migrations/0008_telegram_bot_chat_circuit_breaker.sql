-- Persistent per-chat circuit breaker for repeated permanent Bot API failures.
-- A circuit is isolated to one chat and remains open until explicit operator recovery.
CREATE TABLE IF NOT EXISTS telegram_bot_chat_circuit_breaker (
    chat_id TEXT PRIMARY KEY NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    is_open INTEGER NOT NULL DEFAULT 0 CHECK (is_open IN (0, 1)),
    last_error_code INTEGER CHECK (last_error_code IS NULL OR last_error_code IN (400, 403)),
    updated_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (updated_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_chat_circuit_breaker_open
    ON telegram_bot_chat_circuit_breaker(is_open, updated_at_ms);
