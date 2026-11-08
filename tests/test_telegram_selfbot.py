import sys
import types
import unittest
from unittest.mock import patch

from kagecatch.telegram_selfbot import TelegramSelfbotController


class FakeButton:
    @staticmethod
    def inline(text, data):
        return {"text": text, "data": data}


class FakeEvents:
    class NewMessage:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class CallbackQuery:
        pass


class FakeClient:
    def __init__(self):
        self.handlers = []

    def add_event_handler(self, callback, event):
        self.handlers.append((callback, event))


class FakeMessageEvent:
    is_private = True
    chat_id = 12345

    def __init__(self, text):
        self.raw_text = text
        self.responses = []

    async def respond(self, text, buttons=None):
        self.responses.append({"text": text, "buttons": buttons})


class TelegramSelfbotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.telethon = types.SimpleNamespace(Button=FakeButton, events=FakeEvents)
        self.patch = patch.dict(sys.modules, {"telethon": self.telethon})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    async def test_attach_registers_incoming_outgoing_and_callback_listeners(self):
        controller = TelegramSelfbotController()
        client = FakeClient()

        await controller.attach(client, "12345")

        self.assertEqual(len(client.handlers), 3)
        self.assertEqual(client.handlers[0][1].kwargs, {"incoming": True})
        self.assertEqual(client.handlers[1][1].kwargs, {"outgoing": True})

    async def test_dot_commands_control_only_the_current_users_catch_state(self):
        controller = TelegramSelfbotController()
        client = FakeClient()
        await controller.attach(client, "12345")
        outgoing = client.handlers[1][0]

        on_event = FakeMessageEvent(".روشن")
        await outgoing(on_event)
        self.assertTrue(controller.is_enabled("12345"))
        self.assertIn("روشن", on_event.responses[0]["text"])

        panel_event = FakeMessageEvent(".پنل")
        await outgoing(panel_event)
        self.assertIn("پنل سلف", panel_event.responses[0]["text"])
        self.assertTrue(panel_event.responses[0]["buttons"])

        off_event = FakeMessageEvent(".خاموش")
        await outgoing(off_event)
        self.assertFalse(controller.is_enabled("12345"))

    async def test_dot_commands_ignore_other_chats(self):
        controller = TelegramSelfbotController()
        client = FakeClient()
        await controller.attach(client, "12345")
        outgoing = client.handlers[1][0]
        event = FakeMessageEvent(".روشن")
        event.chat_id = 999
        await outgoing(event)
        self.assertFalse(controller.is_enabled("12345"))
        self.assertEqual(event.responses, [])


if __name__ == "__main__":
    unittest.main()
