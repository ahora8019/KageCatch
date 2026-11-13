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

    async def test_incoming_handler_can_be_attached_after_runtime_startup(self):
        received = []
        controller = TelegramSelfbotController()
        controller.set_incoming_handler(lambda user_id, event: received.append((user_id, event)))
        client = FakeClient()
        await controller.attach(client, "12345")

        event = object()
        await client.handlers[0][0](event)

        self.assertEqual(received, [("12345", event)])

    async def test_dot_commands_control_only_the_current_users_catch_state(self):
        controller = TelegramSelfbotController()
        client = FakeClient()
        await controller.attach(client, "12345")
        outgoing = client.handlers[1][0]

        on_event = FakeMessageEvent(".روشن")
        await outgoing(on_event)
        self.assertTrue(controller.is_enabled("12345"))
        self.assertIn("روشن", on_event.responses[0]["text"])

        # In-chat panels are group-only and are rendered by the Control Bot.
        # Saved Messages must not fall back to Telethon inline keyboards.
        panel_event = FakeMessageEvent(".پنل")
        await outgoing(panel_event)
        self.assertEqual(panel_event.responses, [])

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


class FakeGroupMessageEvent:
    is_private = False
    is_group = True
    is_channel = False
    chat_id = -100123456
    sender_id = 12345
    id = 987
    raw_text = ".panel"

    def __init__(self, text=".panel", sender_id=12345):
        self.raw_text = text
        self.sender_id = sender_id
        self.deleted = False
        self.responses = []

    async def delete(self):
        self.deleted = True

    async def respond(self, text, buttons=None):
        self.responses.append({"text": text, "buttons": buttons})


class TelegramPanelTriggerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.telethon = types.SimpleNamespace(Button=FakeButton, events=FakeEvents)
        self.patch = patch.dict(sys.modules, {"telethon": self.telethon})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    async def test_group_panel_is_queued_before_source_message_is_deleted(self):
        calls = []
        async def enqueue(**task):
            calls.append(task)
            return {"accepted": True, "request_id": "req-1"}

        controller = TelegramSelfbotController(panel_requester=enqueue)
        client = FakeClient()
        await controller.attach(client, "12345")
        event = FakeGroupMessageEvent(".panel")
        await client.handlers[1][0](event)

        self.assertEqual(calls, [{
            "owner_id": "12345",
            "chat_id": -100123456,
            "source_message_id": 987,
        }])
        self.assertTrue(event.deleted)
        self.assertEqual(event.responses, [])

    async def test_persian_panel_command_uses_same_queue(self):
        calls = []
        async def enqueue(**task):
            calls.append(task)
            return {"accepted": True, "request_id": "req-2"}

        controller = TelegramSelfbotController(panel_requester=enqueue)
        client = FakeClient()
        await controller.attach(client, "12345")
        event = FakeGroupMessageEvent(".پنل")
        await client.handlers[1][0](event)

        self.assertEqual(len(calls), 1)
        self.assertTrue(event.deleted)

    async def test_group_panel_command_is_not_deleted_when_queue_rejects(self):
        async def enqueue(**task):
            return {"accepted": False}

        controller = TelegramSelfbotController(panel_requester=enqueue)
        client = FakeClient()
        await controller.attach(client, "12345")
        event = FakeGroupMessageEvent()
        await client.handlers[1][0](event)

        self.assertFalse(event.deleted)
        self.assertTrue(event.responses)

    async def test_other_sender_cannot_trigger_this_session_panel(self):
        calls = []
        async def enqueue(**task):
            calls.append(task)
            return {"accepted": True}

        controller = TelegramSelfbotController(panel_requester=enqueue)
        client = FakeClient()
        await controller.attach(client, "12345")
        event = FakeGroupMessageEvent(sender_id=99999)
        await client.handlers[1][0](event)

        self.assertEqual(calls, [])
        self.assertFalse(event.deleted)

    async def test_private_chat_is_not_accepted_for_in_chat_bot_panel(self):
        calls = []
        async def enqueue(**task):
            calls.append(task)
            return {"accepted": True}

        controller = TelegramSelfbotController(panel_requester=enqueue)
        client = FakeClient()
        await controller.attach(client, "12345")
        event = FakeGroupMessageEvent()
        event.is_group = False
        event.is_private = True
        event.chat_id = 12345
        await client.handlers[1][0](event)

        self.assertEqual(calls, [])
        self.assertFalse(event.deleted)
