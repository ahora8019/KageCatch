-- Durable per-owner daily catch quota ledger.
CREATE TABLE IF NOT EXISTS daily_quota_limits (
    owner_id TEXT NOT NULL,
    quota_date TEXT NOT NULL,
    quota_limit INTEGER NOT NULL DEFAULT 20 CHECK (quota_limit > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, quota_date)
);

CREATE TABLE IF NOT EXISTS daily_quotas (
    request_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    quota_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'confirmed', 'failed')),
    consumes_quota INTEGER NOT NULL DEFAULT 1 CHECK (consumes_quota IN (0, 1)),
    chat_id INTEGER,
    spawn_message_id INTEGER,
    command_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id, quota_date)
        REFERENCES daily_quota_limits(owner_id, quota_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_quotas_owner_date
    ON daily_quotas(owner_id, quota_date, status);

CREATE INDEX IF NOT EXISTS idx_daily_quotas_spawn
    ON daily_quotas(owner_id, chat_id, spawn_message_id);
