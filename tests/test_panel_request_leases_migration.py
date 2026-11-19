import sqlite3
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class PanelRequestLeasesMigrationTests(unittest.TestCase):
    def test_migration_adds_fenced_lease_columns_and_backfills_existing_claims(self) -> None:
        db = sqlite3.connect(":memory:")
        try:
            db.executescript(
                (MIGRATIONS / "0004_panel_requests.sql").read_text(encoding="utf-8")
            )
            db.execute(
                "INSERT INTO panel_requests "
                "(request_id, idempotency_key, owner_id, chat_id, source_message_id, status, attempts, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("pending-id", "pending-key", "12345", "-1001", 11, "pending", 0,
                 "2099-01-01 00:00:00"),
            )
            db.execute(
                "INSERT INTO panel_requests "
                "(request_id, idempotency_key, owner_id, chat_id, source_message_id, status, attempts, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("processing-id", "processing-key", "12345", "-1001", 12, "processing", 1,
                 "2099-01-01 00:00:00"),
            )

            migration = MIGRATIONS / "0007_panel_request_leases.sql"
            self.assertTrue(migration.is_file(), "the D1 lease migration must be present in source control")
            db.executescript(migration.read_text(encoding="utf-8"))

            columns = {
                row[1]: {"type": row[2], "notnull": row[3]}
                for row in db.execute("PRAGMA table_info(panel_requests)")
            }
            self.assertEqual(columns["lease_token"], {"type": "TEXT", "notnull": 0})
            self.assertEqual(columns["lease_expires_at"], {"type": "TEXT", "notnull": 0})

            pending = db.execute(
                "SELECT status, lease_token, lease_expires_at FROM panel_requests WHERE request_id = ?",
                ("pending-id",),
            ).fetchone()
            self.assertEqual(pending, ("pending", None, None))

            processing = db.execute(
                "SELECT status, lease_token, lease_expires_at FROM panel_requests WHERE request_id = ?",
                ("processing-id",),
            ).fetchone()
            self.assertEqual(processing[0:2], ("processing", None))
            lease_until = datetime.strptime(processing[2], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            self.assertGreaterEqual(lease_until, now + timedelta(minutes=4))
            self.assertLessEqual(lease_until, now + timedelta(minutes=6))

            indexes = {
                row[1] for row in db.execute("PRAGMA index_list(panel_requests)")
            }
            self.assertIn("idx_panel_requests_processing_lease", indexes)
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM panel_requests").fetchone()[0],
                2,
                "the migration must preserve existing panel requests",
            )
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
