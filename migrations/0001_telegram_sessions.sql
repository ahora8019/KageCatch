-- Encrypted Telegram StringSessions only. Fernet encryption/decryption is owned by Python SessionManager.
CREATE TABLE IF NOT EXISTS telegram_sessions (
    user_id TEXT PRIMARY KEY NOT NULL,
    encrypted_session TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_telegram_sessions_updated_at
    ON telegram_sessions(updated_at);
