import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class ManualReviewSpawnContextMigrationTests(unittest.TestCase):
    def test_migration_adds_nullable_spawn_context_without_losing_existing_rows(self) -> None:
        db = sqlite3.connect(":memory:")
        try:
            db.executescript(
                (MIGRATIONS / "0003_manual_review_items.sql").read_text(encoding="utf-8")
            )
            db.execute(
                "INSERT INTO manual_review_items "
                "(review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("a" * 32, "user-1", 7, "Example Anime", '["Sakura"]',
                 "2026-11-19T00:00:00Z", "2026-11-20T00:00:00Z", "pending"),
            )

            migration = MIGRATIONS / "0006_manual_review_spawn_context.sql"
            self.assertTrue(migration.is_file(), "the applied D1 migration must be present in source control")
            db.executescript(migration.read_text(encoding="utf-8"))

            columns = {
                row[1]: {"type": row[2], "notnull": row[3]}
                for row in db.execute("PRAGMA table_info(manual_review_items)")
            }
            self.assertEqual(columns["spawn_context_json"], {"type": "TEXT", "notnull": 0})
            self.assertEqual(
                db.execute(
                    "SELECT review_id, spawn_context_json FROM manual_review_items"
                ).fetchall(),
                [("a" * 32, None)],
            )
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
