import unittest

from kagecatch.engine import Spawn, Candidate
from kagecatch.telegram_catch_adapter import TelethonCatchAdapter


class FakeMessage:
    def __init__(self, message_id):
        self.id = message_id


class FakeClient:
    def __init__(self, error=None):
        self.sent = []
        self.error = error

    async def send_message(self, username, text):
        self.sent.append((username, text))
        if self.error:
            raise self.error
        return FakeMessage(77)


class FakeGuard:
    def __init__(self, allowed=True):
        self.allowed = allowed
        self.events = []
        self.sent = []

    def check_send(self, *, chat_id):
        return type("Decision", (), {
            "allowed": self.allowed,
            "reason": "manual_lock",
        })()

    def record_send(self, *, chat_id):
        self.sent.append(chat_id)

    def observe_error(self, error):
        self.events.append(type(error).__name__)


class TelegramCatchAdapterTests(unittest.IsolatedAsyncioTestCase):
    def spawn(self):
        return Spawn(
            source="henta_catcher",
            chat_id=100,
            message_id=200,
            media_kind="image",
            candidates=(Candidate("Sakura", 0.99),),
        )

    async def test_sends_command_only_after_safety_guard_allows_it(self):
        client, guard = FakeClient(), FakeGuard()
        adapter = TelethonCatchAdapter(
            client=client, source="henta_catcher", dispatch_enabled=True,
            safety_guard=guard,
        )
        receipt = await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(client.sent, [("HentaCatcherBot", "/catch Sakura")])
        self.assertEqual(receipt.reference, "HentaCatcherBot:77")
        self.assertEqual(guard.sent, [100])
        self.assertFalse(await adapter.verify_catch(receipt))

    async def test_only_target_response_verifier_can_confirm_success(self):
        client, guard = FakeClient(), FakeGuard()
        async def verifier(actual_client, target, outgoing, receipt):
            return (
                actual_client is client
                and target == "HentaCatcherBot"
                and outgoing.id == 77
                and receipt.character_name == "Sakura"
            )

        adapter = TelethonCatchAdapter(
            client=client,
            source="henta_catcher",
            response_verifier=verifier,
            dispatch_enabled=True,
            safety_guard=guard,
        )
        receipt = await adapter.send_catch(self.spawn(), "Sakura")
        self.assertTrue(await adapter.verify_catch(receipt))

    async def test_rejects_spawn_from_another_source_before_sending(self):
        client, guard = FakeClient(), FakeGuard()
        adapter = TelethonCatchAdapter(
            client=client, source="henta_catcher", dispatch_enabled=True,
            safety_guard=guard,
        )
        spawn = self.spawn()
        wrong = Spawn(
            source="character_catcher",
            chat_id=spawn.chat_id,
            message_id=spawn.message_id,
            media_kind=spawn.media_kind,
            candidates=spawn.candidates,
        )
        with self.assertRaises(ValueError):
            await adapter.send_catch(wrong, "Sakura")
        self.assertEqual(client.sent, [])

    async def test_dispatch_is_disabled_by_default(self):
        client = FakeClient()
        adapter = TelethonCatchAdapter(client=client, source="henta_catcher")
        with self.assertRaises(RuntimeError):
            await adapter.send_catch(self.spawn(), "Sakura")
        self.assertEqual(client.sent, [])

    async def test_dispatch_without_safety_guard_fails_closed(self):
        client = FakeClient()
        with self.assertRaises(RuntimeError):
            TelethonCatchAdapter(
                client=client, source="henta_catcher", dispatch_enabled=True
            )
        self.assertEqual(client.sent, [])

    async def test_locked_guard_prevents_outbound_send(self):
        client, guard = FakeClient(), FakeGuard(allowed=False)
        adapter = TelethonCatchAdapter(
            client=client, source="henta_catcher", dispatch_enabled=True,
            safety_guard=guard,
        )
        with self.assertRaises(RuntimeError):
            await adapter.send_catch(self.spawn(), "Sakura")
        self.assertEqual(client.sent, [])
        self.assertEqual(guard.sent, [])

    async def test_telegram_session_error_locks_guard_and_is_not_retried(self):
        error = type("SessionRevokedError", (Exception,), {})()
        client, guard = FakeClient(error=error), FakeGuard()
        adapter = TelethonCatchAdapter(
            client=client, source="henta_catcher", dispatch_enabled=True,
            safety_guard=guard,
        )
        with self.assertRaises(type(error)):
            await adapter.send_catch(self.spawn(), "Sakura")
        self.assertEqual(guard.events, ["SessionRevokedError"])
        self.assertEqual(guard.sent, [])


if __name__ == "__main__":
    unittest.main()
