-- Add a monotonic fencing token to existing distributed session leases.
-- Existing lease rows start at token 1; expired-owner takeover increments it.
ALTER TABLE session_locks
ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 1;
