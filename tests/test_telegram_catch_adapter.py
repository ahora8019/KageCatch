import unittest

from kagecatch.engine import Spawn, Candidate
from kagecatch.telegram_catch_adapter import TelethonCatchAdapter


class FakeMessage:
    def __init__(self, message_id):
        self.id = message_id


class FakeClient:
    def __init__(self):
        self.sent = []

    async def send_message(self, username, text):
        self.sent.append((username, text))
        return FakeMessage(77)


class TelegramCatchAdapterTests(unittest.IsolatedAsyncioTestCase):
    def spawn(self):
        return Spawn(
            source="henta_catcher",
            chat_id=100,
            message_id=200,
            media_kind="image",
            candidates=(Candidate("Sakura", 0.99),),
        )

    async def test_sends_command_to_configured_target_using_authorized_client(self):
        client = FakeClient()
        adapter = TelethonCatchAdapter(client=client, source="henta_catcher")
        receipt = await adapter.send_catch(self.spawn(), "Sakura")

        self.assertEqual(client.sent, [("HentaCatcherBot", "/catch Sakura")])
        self.assertEqual(receipt.reference, "HentaCatcherBot:77")
        self.assertFalse(await adapter.verify_catch(receipt))

    async def test_only_target_response_verifier_can_confirm_success(self):
        client = FakeClient()
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
        )
        receipt = await adapter.send_catch(self.spawn(), "Sakura")
        self.assertTrue(await adapter.verify_catch(receipt))

    async def test_rejects_spawn_from_another_source_before_sending(self):
        client = FakeClient()
        adapter = TelethonCatchAdapter(client=client, source="henta_catcher")
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

    async def test_dispatch_requires_explicit_opt_in(self):
        client = FakeClient()
        adapter = TelethonCatchAdapter(
            client=client, source="henta_catcher", dispatch_enabled=True
        )
        receipt = await adapter.send_catch(self.spawn(), "Sakura")
        self.assertEqual(receipt.reference, "HentaCatcherBot:77")


if __name__ == "__main__":
    unittest.main()
