import pytest

from kagecatch.bot.enrollment_handlers import EnrollmentBotHandler


class FakeEnrollmentService:
    def __init__(self, cancel_result=False):
        self.cancel_result = cancel_result
        self.cancelled = []

    async def cancel(self, owner_id):
        self.cancelled.append(owner_id)
        return self.cancel_result


class FakeMessenger:
    def __init__(self):
        self.messages = []

    async def send_message(self, chat_id, text):
        self.messages.append((chat_id, text))


def update(text, *, user_id=12345, chat_id=None, chat_type="private"):
    return {
        "message": {
            "from": {"id": user_id},
            "chat": {
                "id": user_id if chat_id is None else chat_id,
                "type": chat_type,
            },
            "text": text,
        }
    }


@pytest.mark.asyncio
async def test_connect_never_requests_or_accepts_login_secrets():
    service = FakeEnrollmentService()
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger, bot_username="KageCatchBot")

    handled = await handler.handle(update("/connect"),)

    assert handled is True
    assert service.cancelled == []
    assert len(messenger.messages) == 1
    assert messenger.messages[0][0] == 12345
    assert "فعال نیست" in messenger.messages[0][1]
    assert "کد ورود" in messenger.messages[0][1]


@pytest.mark.asyncio
async def test_cancel_only_cancels_the_calling_private_user_challenge():
    service = FakeEnrollmentService(cancel_result=True)
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger)

    handled = await handler.handle(update("/cancel", user_id=456))

    assert handled is True
    assert service.cancelled == [456]
    assert messenger.messages[0][0] == 456
    assert "لغو" in messenger.messages[0][1]


@pytest.mark.asyncio
async def test_group_messages_are_ignored_without_touching_enrollment():
    service = FakeEnrollmentService(cancel_result=True)
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger)

    handled = await handler.handle(
        update("/cancel", user_id=456, chat_id=-100123, chat_type="group")
    )

    assert handled is False
    assert service.cancelled == []
    assert messenger.messages == []


@pytest.mark.asyncio
async def test_chat_id_must_match_sender_id():
    service = FakeEnrollmentService()
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger)

    handled = await handler.handle(update("/connect", user_id=456, chat_id=789))

    assert handled is False
    assert messenger.messages == []


@pytest.mark.asyncio
async def test_plain_text_including_otp_or_password_is_never_processed():
    service = FakeEnrollmentService()
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger)

    handled = await handler.handle(update("123456"))

    assert handled is False
    assert service.cancelled == []
    assert messenger.messages == []


@pytest.mark.asyncio
async def test_unknown_or_malformed_update_is_ignored():
    service = FakeEnrollmentService()
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger)

    assert await handler.handle({}) is False
    assert await handler.handle({"message": {"text": "/connect"}}) is False
    assert await handler.handle(update("/connect extra")) is False
    assert service.cancelled == []
    assert messenger.messages == []


@pytest.mark.asyncio
async def test_bot_mention_is_supported_but_other_bot_mentions_are_ignored():
    service = FakeEnrollmentService()
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger, bot_username="KageCatchBot")

    assert await handler.handle(update("/connect@KageCatchBot")) is True
    assert await handler.handle(update("/connect@OtherBot")) is False
    assert len(messenger.messages) == 1


@pytest.mark.asyncio
async def test_invalid_sender_ids_are_ignored():
    service = FakeEnrollmentService()
    messenger = FakeMessenger()
    handler = EnrollmentBotHandler(service, messenger)

    assert await handler.handle(update("/cancel", user_id=True)) is False
    assert service.cancelled == []
    assert messenger.messages == []
