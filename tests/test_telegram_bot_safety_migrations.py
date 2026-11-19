import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


def apply_migration(connection: sqlite3.Connection, name: str) -> None:
    connection.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))


class TelegramBotSafetyMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        apply_migration(self.db, "0005_telegram_bot_safety.sql")
        apply_migration(self.db, "0006_telegram_bot_chat_pacing.sql")

    def tearDown(self) -> None:
        self.db.close()

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
