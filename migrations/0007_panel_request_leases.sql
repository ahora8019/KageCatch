-- Fenced delivery leases for concurrent/restarted panel queue processors.
ALTER TABLE panel_requests ADD COLUMN lease_token TEXT;
ALTER TABLE panel_requests ADD COLUMN lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_panel_requests_processing_lease
    ON panel_requests(status, lease_expires_at);
