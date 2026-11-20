import sqlite3
import unittest
from pathlib import Path


class DurableJobQueueMigrationTests(unittest.TestCase):
    def test_creates_fenced_durable_queue_and_claim_indexes(self):
        sql = (Path(__file__).parents[1] / "migrations" / "0009_durable_job_queue.sql").read_text()
        db = sqlite3.connect(":memory:")
        db.executescript(sql)
        db.execute("INSERT INTO catch_jobs(job_id,job_type,payload_json,status,max_attempts,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                   ("a" * 32, "spawn.recognize", '{"spawn_id":1}', "queued", 3, 1, 1, 1))
        row = db.execute("SELECT status,lease_generation FROM catch_jobs WHERE job_id=?", ("a" * 32,)).fetchone()
        self.assertEqual(row, ("queued", 0))
        indexes = {r[1] for r in db.execute("PRAGMA index_list(catch_jobs)")}
        self.assertIn("idx_catch_jobs_claim", indexes)
        self.assertIn("idx_catch_jobs_type_claim", indexes)

    def test_rejects_invalid_payload_and_job_status(self):
        sql = (Path(__file__).parents[1] / "migrations" / "0009_durable_job_queue.sql").read_text()
        db = sqlite3.connect(":memory:")
        db.executescript(sql)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO catch_jobs(job_id,job_type,payload_json,status,max_attempts,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                       ("b" * 32, "spawn.recognize", "not-json", "queued", 3, 1, 1, 1))
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO catch_jobs(job_id,job_type,payload_json,status,max_attempts,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                       ("c" * 32, "spawn.recognize", "{}", "unknown", 3, 1, 1, 1))
