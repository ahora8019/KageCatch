-- Fenced delivery leases for concurrent/restarted panel queue processors.
ALTER TABLE panel_requests ADD COLUMN lease_token TEXT;
ALTER TABLE panel_requests ADD COLUMN lease_expires_at TEXT;

-- Preserve pre-existing in-flight rows for a short grace period. Without this
-- backfill, NULL lease expiries would never satisfy the recovery comparison.
-- Legacy workers do not know lease tokens, so new completions remain fenced.
UPDATE panel_requests
SET lease_expires_at = datetime('now', '+5 minutes')
WHERE status = 'processing' AND lease_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_panel_requests_processing_lease
    ON panel_requests(status, lease_expires_at);
