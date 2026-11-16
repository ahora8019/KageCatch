"""Persistence tests for Telegram safety state; SQLite only, no network calls."""
import tempfile
import unittest
from pathlib import Path

from kagecatch.sqlite_safety_state_store import SQLiteSafetyStateStore
from kagecatch.telegram_safety_guard import GuardMode, TelegramSafetyGuard


class FakeClock:
    def __init__(self, value=100.0):
        self.value = value
    def __call__(self):
        return self.value


class PersistentSafetyStateTests(unittest.TestCase):
    def test_session_revocation_lock_survives_guard_and_process_recreation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "safety.sqlite3"
            store = SQLiteSafetyStateStore(path)
            first = TelegramSafetyGuard(
                clock=FakeClock(), wall_clock=FakeClock(1_800_000_000),
                state_store=store, owner_id="owner-a",
            )
            first.observe_error(type("SessionRevokedError", (Exception,), {})())

            restarted = TelegramSafetyGuard(
                clock=FakeClock(), wall_clock=FakeClock(1_800_000_001),
                state_store=SQLiteSafetyStateStore(path), owner_id="owner-a",
            )
            self.assertEqual(restarted.mode, GuardMode.SESSION_LOCKED)
            self.assertFalse(restarted.reserve_send(chat_id=123).allowed)

    def test_security_lock_survives_restart_and_requires_security_review(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "safety.sqlite3"
            store = SQLiteSafetyStateStore(path)
            guard = TelegramSafetyGuard(
                clock=FakeClock(), wall_clock=FakeClock(1_800_000_000),
                state_store=store, owner_id="owner-a",
            )
            guard.observe_error(type("UserDeactivatedBanError", (Exception,), {})())
            restarted = TelegramSafetyGuard(
                clock=FakeClock(), wall_clock=FakeClock(1_800_000_001),
                state_store=SQLiteSafetyStateStore(path), owner_id="owner-a",
            )
            self.assertEqual(restarted.mode, GuardMode.SECURITY_LOCKED)
            self.assertFalse(restarted.clear_lock(
                operator_confirmed=True, session_reauthorized=True
            ))
            self.assertTrue(restarted.clear_lock(
                operator_confirmed=True,
                session_reauthorized=True,
                security_reviewed=True,
            ))

    def test_state_is_isolated_between_owners(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "safety.sqlite3"
            store = SQLiteSafetyStateStore(path)
            locked = TelegramSafetyGuard(
                clock=FakeClock(), state_store=store, owner_id="owner-a"
            )
            locked.lock()
            other = TelegramSafetyGuard(
                clock=FakeClock(), state_store=SQLiteSafetyStateStore(path),
                owner_id="owner-b",
            )
            self.assertEqual(locked.mode, GuardMode.MANUAL_LOCKED)
            self.assertEqual(other.mode, GuardMode.OPEN)

    def test_rate_limit_expiry_is_persisted_as_wall_clock_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "safety.sqlite3"
            store = SQLiteSafetyStateStore(path)
            guard = TelegramSafetyGuard(
                clock=FakeClock(), wall_clock=FakeClock(1_800_000_000),
                state_store=store, owner_id="owner-a",
            )
            guard.observe_error(type("FloodWaitError", (Exception,), {"seconds": 30})())
            restarted = TelegramSafetyGuard(
                clock=FakeClock(), wall_clock=FakeClock(1_800_000_010),
                state_store=SQLiteSafetyStateStore(path), owner_id="owner-a",
            )
            decision = restarted.reserve_send(chat_id=1)
            self.assertFalse(decision.allowed)
            self.assertEqual(decision.retry_after, 20)


if __name__ == "__main__":
    unittest.main()
