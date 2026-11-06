-- Temporary Telegram login challenges; payload is Fernet-encrypted by Python SessionManager.
CREATE TABLE IF NOT EXISTS telegram_auth_challenges (
    user_id TEXT PRIMARY KEY NOT NULL,
    encrypted_payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_telegram_auth_challenges_updated_at
    ON telegram_auth_challenges(updated_at);
