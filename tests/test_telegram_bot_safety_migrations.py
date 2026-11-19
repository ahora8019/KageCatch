import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


def apply_migration(connection: sqlite3.Connection, name: str) -> None:
    connection.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))


def migration_sort_key(path: Path) -> tuple[int, int, str]:
    """Mirror Wrangler's D1 ordering: numeric prefix, then lexical filename tie-break."""
    prefix = path.name.split("_", 1)[0]
    try:
        return (0, int(prefix), path.name)
    except ValueError:
        return (1, 0, path.name)


def migration_paths() -> list[Path]:
    return sorted(MIGRATIONS.glob("*.sql"), key=migration_sort_key)


def apply_pending_migrations(connection: sqlite3.Connection) -> list[str]:
    """Apply the complete flat D1 migration chain, recording Wrangler-style filenames."""
    applied = {
        row[0] for row in connection.execute("SELECT name FROM d1_migrations").fetchall()
    }
    applied_now: list[str] = []
    for path in migration_paths():
        if path.name in applied:
            continue
        connection.executescript(path.read_text(encoding="utf-8"))
        connection.execute("INSERT INTO d1_migrations (name) VALUES (?)", (path.name,))
        applied.add(path.name)
        applied_now.append(path.name)
    return applied_now


class TelegramBotSafetyMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.execute(
            "CREATE TABLE d1_migrations ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "name TEXT UNIQUE, "
            "applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
        )
        self.applied_migrations = apply_pending_migrations(self.db)

    def tearDown(self) -> None:
        self.db.close()

    def test_fresh_database_replays_complete_chain_in_d1_order(self) -> None:
        names = [
            row[0]
            for row in self.db.execute("SELECT name FROM d1_migrations ORDER BY id").fetchall()
        ]
        self.assertEqual(names, self.applied_migrations)

        manual_review = "0006_manual_review_spawn_context.sql"
        chat_pacing = "0007_telegram_bot_chat_pacing.sql"
        self.assertIn(manual_review, names)
        self.assertIn(chat_pacing, names)
        self.assertLess(names.index("0005_telegram_bot_safety.sql"), names.index(manual_review))
        self.assertLess(names.index(manual_review), names.index(chat_pacing))
        self.assertLess(names.index(chat_pacing), names.index("0008_telegram_bot_chat_circuit_breaker.sql"))

        review_columns = {
            row[1] for row in self.db.execute("PRAGMA table_info(manual_review_items)").fetchall()
        }
        self.assertIn("spawn_context_json", review_columns)
        self.assertEqual(
            self.db.execute("SELECT singleton_id FROM telegram_bot_safety").fetchall(),
            [("control-bot",)],
        )

    def test_existing_ledger_with_manual_review_already_applied_can_apply_safety_chain(self) -> None:
        db = sqlite3.connect(":memory:")
        try:
            db.execute(
                "CREATE TABLE d1_migrations ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "name TEXT UNIQUE, "
                "applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
            )
            already_applied = {
                "0001_telegram_sessions.sql",
                "0002_telegram_auth_challenges.sql",
                "0003_manual_review_items.sql",
                "0004_panel_requests.sql",
                "0006_manual_review_spawn_context.sql",
            }
            for path in migration_paths():
                if path.name not in already_applied:
                    continue
                db.executescript(path.read_text(encoding="utf-8"))
                db.execute("INSERT INTO d1_migrations (name) VALUES (?)", (path.name,))

            pending = apply_pending_migrations(db)
            self.assertEqual(
                pending,
                [
                    "0005_telegram_bot_safety.sql",
                    "0007_telegram_bot_chat_pacing.sql",
                    "0008_telegram_bot_chat_circuit_breaker.sql",
                ],
            )
            review_columns = {
                row[1] for row in db.execute("PRAGMA table_info(manual_review_items)").fetchall()
            }
            self.assertIn("spawn_context_json", review_columns)
            self.assertEqual(
                db.execute("SELECT singleton_id FROM telegram_bot_safety").fetchall(),
                [("control-bot",)],
            )
        finally:
            db.close()

    def test_applied_ledger_prevents_replaying_non_idempotent_migration(self) -> None:
        before = self.db.execute("SELECT name FROM d1_migrations ORDER BY id").fetchall()
        self.assertEqual(apply_pending_migrations(self.db), [])
        after = self.db.execute("SELECT name FROM d1_migrations ORDER BY id").fetchall()
        self.assertEqual(after, before)

    def test_global_control_bot_state_is_created_once_with_safe_defaults(self) -> None:
        rows = self.db.execute(
            "SELECT singleton_id, paused_until_ms, next_allowed_at_ms, pause_reason "
            "FROM telegram_bot_safety"
        ).fetchall()
        self.assertEqual(rows, [("control-bot", 0, 0, None)])

        apply_migration(self.db, "0005_telegram_bot_safety.sql")
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM telegram_bot_safety").fetchone()[0],
            1,
        )

    def test_chat_pacing_state_is_independent_per_group(self) -> None:
        self.db.executemany(
            "INSERT INTO telegram_bot_chat_pacing (chat_id, next_allowed_at_ms) VALUES (?, ?)",
            [("-100123", 1000), ("-100456", 2000)],
        )
        self.assertEqual(
            self.db.execute(
                "SELECT chat_id, next_allowed_at_ms FROM telegram_bot_chat_pacing ORDER BY chat_id"
            ).fetchall(),
            [("-100123", 1000), ("-100456", 2000)],
        )

    def test_chat_circuit_state_isolated_and_rejects_invalid_values(self) -> None:
        self.db.executemany(
            "INSERT INTO telegram_bot_chat_circuit_breaker "
            "(chat_id, consecutive_failures, is_open, last_error_code, updated_at_ms) "
            "VALUES (?, ?, ?, ?, ?)",
            [("111", 3, 1, 403, 1000), ("222", 1, 0, 400, 2000)],
        )
        self.assertEqual(
            self.db.execute(
                "SELECT chat_id, consecutive_failures, is_open FROM telegram_bot_chat_circuit_breaker ORDER BY chat_id"
            ).fetchall(),
            [("111", 3, 1), ("222", 1, 0)],
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO telegram_bot_chat_circuit_breaker "
                "(chat_id, consecutive_failures, is_open, last_error_code, updated_at_ms) "
                "VALUES ('333', -1, 0, 400, 0)"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO telegram_bot_chat_circuit_breaker "
                "(chat_id, consecutive_failures, is_open, last_error_code, updated_at_ms) "
                "VALUES ('444', 1, 2, 403, 0)"
            )

    def test_safety_state_rejects_unknown_singleton_and_negative_timestamps(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO telegram_bot_safety (singleton_id) VALUES ('another-bot')"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE telegram_bot_safety SET paused_until_ms = -1 WHERE singleton_id = 'control-bot'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO telegram_bot_chat_pacing (chat_id, next_allowed_at_ms) VALUES (?, ?)",
                ("-100999", -1),
            )


if __name__ == "__main__":
    unittest.main()
