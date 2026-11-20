CREATE TABLE IF NOT EXISTS catch_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 32),
  job_type TEXT NOT NULL CHECK (length(job_type) BETWEEN 1 AND 128),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  idempotency_key TEXT UNIQUE,
  worker_id TEXT,
  lease_until REAL,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  run_after REAL NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catch_jobs_claim
  ON catch_jobs(status, run_after, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_jobs_type_claim
  ON catch_jobs(job_type, status, run_after, priority DESC, created_at);
