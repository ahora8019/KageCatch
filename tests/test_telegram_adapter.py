import unittest

from kagecatch.engine import Spawn
from kagecatch.telegram_adapter import TelethonCatchAdapter


class FakeMessage:
    id = 123


class FakeClient:
    def __init__(self):
        self.sent = []

    async def send_message(self, entity, message):
        self.sent.append((entity, message))
        return FakeMessage()


class TelethonAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = FakeClient()
        self.verified = True
        async def verifier(username, receipt):
            return self.verified
        self.adapter = TelethonCatchAdapter(
            source="henta_catcher",
            client=self.client,
            response_verifier=verifier,
        )

    async def test_sends_expected_command_to_target_bot(self):
        spawn = Spawn("henta_catcher", 1, 2, "image", ())
        receipt = await self.adapter.send_catch(spawn, "Sakura")
        self.assertEqual(self.client.sent, [("HentaCatcherBot", "/catch Sakura")])
        self.assertEqual(receipt.reference, "HentaCatcherBot:123")

    async def test_verification_uses_injected_verifier(self):
        from kagecatch.engine import CatchReceipt
        self.assertTrue(await self.adapter.verify_catch(CatchReceipt("ref", "Sakura")))
        self.verified = False
        self.assertFalse(await self.adapter.verify_catch(CatchReceipt("ref", "Sakura")))

    async def test_wrong_media_is_rejected(self):
        spawn = Spawn("henta_catcher", 1, 2, "video", ())
        with self.assertRaises(ValueError):
            await self.adapter.send_catch(spawn, "Sakura")

    async def test_frozen_senpai_adapter_is_not_constructed(self):
        with self.assertRaises(RuntimeError):
            TelethonCatchAdapter(
                source="senpai_catcher",
                client=self.client,
                response_verifier=self.adapter._response_verifier,
            )


if __name__ == "__main__":
    unittest.main()
