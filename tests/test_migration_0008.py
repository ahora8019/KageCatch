"""Regression coverage for the distributed session-lock fencing migration."""
import sqlite3
import unittest
from pathlib import Path


MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


class SessionLockFencingMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)

        # Recreate the pre-0008 schema and an already-existing lease row.
        self.db.executescript(
            (MIGRATIONS / "0005_session_locks.sql").read_text(encoding="utf-8")
        )
        self.db.execute(
            """
            INSERT INTO session_locks (session_id, locked_by, expires_at)
            VALUES (?, ?, ?)
            """,
            ("existing-session", "old-owner", 1_900_000_000),
        )
        self.db.commit()

    def test_existing_and_new_rows_start_at_fencing_generation_one(self):
        self.db.executescript(
            (MIGRATIONS / "0008_session_lock_fencing_token.sql").read_text(
                encoding="utf-8"
            )
        )

        existing = self.db.execute(
            "SELECT fencing_token FROM session_locks WHERE session_id = ?",
            ("existing-session",),
        ).fetchone()
        self.assertEqual(existing, (1,))

        self.db.execute(
            """
            INSERT INTO session_locks (session_id, locked_by, expires_at)
            VALUES (?, ?, ?)
            """,
            ("new-session", "new-owner", 1_900_000_100),
        )
        created = self.db.execute(
            "SELECT fencing_token FROM session_locks WHERE session_id = ?",
            ("new-session",),
        ).fetchone()
        self.assertEqual(created, (1,))

        column = next(
            row
            for row in self.db.execute("PRAGMA table_info(session_locks)")
            if row[1] == "fencing_token"
        )
        self.assertEqual(column[2].upper(), "INTEGER")
        self.assertEqual(column[3], 1)
        self.assertEqual(column[4], "1")


if __name__ == "__main__":
    unittest.main()
