"""Fail-closed Telegram safety guard tests; no Telegram network access."""
import unittest

from kagecatch.telegram_safety_guard import GuardMode, TelegramSafetyGuard


class FakeClock:
    def __init__(self):
        self.value = 100.0
    def __call__(self):
        return self.value
    def advance(self, seconds):
        self.value += seconds


class TelegramSafetyGuardTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.guard = TelegramSafetyGuard(clock=self.clock, min_global_interval=0.5, min_chat_interval=1.0)

    def test_outbound_is_allowed_initially_then_rate_limited_per_chat(self):
        self.assertTrue(self.guard.check_send(chat_id=10).allowed)
        self.guard.record_send(chat_id=10)
        self.clock.advance(0.5)
        decision = self.guard.check_send(chat_id=10)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "chat_cooldown")
        self.assertGreater(decision.retry_after, 0)

    def test_global_cooldown_applies_across_chats(self):
        self.assertTrue(self.guard.check_send(chat_id=10).allowed)
        self.guard.record_send(chat_id=10)
        decision = self.guard.check_send(chat_id=20)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "global_cooldown")

    def test_flood_wait_sets_global_cooldown_using_retry_after(self):
        error = type("FloodWaitError", (Exception,), {"seconds": 12})()
        event = self.guard.observe_error(error)
        self.assertEqual(event.category, "rate_limit")
        self.assertEqual(self.guard.mode, GuardMode.RATE_LIMITED)
        self.assertEqual(self.guard.check_send(chat_id=10).retry_after, 12)

    def test_bot_api_retry_after_is_honored(self):
        error = type("TelegramAPIError", (Exception,), {"retry_after": 9})()
        self.guard.observe_error(error)
        self.assertEqual(self.guard.check_send(chat_id=10).retry_after, 9)

    def test_session_revocation_locks_all_outbound_until_manual_reauthorization(self):
        error = type("SessionRevokedError", (Exception,), {})()
        event = self.guard.observe_error(error)
        self.assertEqual(event.category, "session_revoked")
        self.assertEqual(self.guard.mode, GuardMode.SESSION_LOCKED)
        self.assertFalse(self.guard.check_send(chat_id=10).allowed)
        self.assertFalse(self.guard.clear_lock(operator_confirmed=True, session_reauthorized=False))
        self.assertTrue(self.guard.clear_lock(operator_confirmed=True, session_reauthorized=True))
        self.assertTrue(self.guard.check_send(chat_id=10).allowed)

    def test_account_security_error_enters_manual_security_lock(self):
        error = type("UserDeactivatedBanError", (Exception,), {})()
        event = self.guard.observe_error(error)
        self.assertEqual(event.category, "security_lock")
        self.assertEqual(self.guard.mode, GuardMode.SECURITY_LOCKED)
        self.assertFalse(self.guard.clear_lock(operator_confirmed=True, session_reauthorized=True))

    def test_unknown_errors_do_not_trigger_false_security_classification(self):
        event = self.guard.observe_error(RuntimeError("temporary internal failure"))
        self.assertEqual(event.category, "transient")
        self.assertEqual(self.guard.mode, GuardMode.OPEN)

    def test_rate_limit_expires_without_clearing_manual_security_lock(self):
        error = type("FloodWaitError", (Exception,), {"seconds": 2})()
        self.guard.observe_error(error)
        self.clock.advance(2)
        self.assertTrue(self.guard.check_send(chat_id=10).allowed)
        self.guard.observe_error(type("SessionRevokedError", (Exception,), {})())
        self.clock.advance(1000)
        self.assertFalse(self.guard.check_send(chat_id=10).allowed)


if __name__ == "__main__":
    unittest.main()
