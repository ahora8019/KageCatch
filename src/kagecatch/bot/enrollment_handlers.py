"""Safe Telegram Bot API handlers for account-enrollment commands.

This boundary deliberately does not accept phone numbers, login codes, or
2FA passwords. Telegram bot private chats are not end-to-end encrypted.
"""

from __future__ import annotations

from typing import Any, Protocol


class EnrollmentCancellation(Protocol):
    async def cancel(self, owner_id: int) -> bool: ...


class MessageSender(Protocol):
    async def send_message(self, chat_id: int, text: str) -> Any: ...


class EnrollmentBotHandler:
    """Handle safe enrollment commands from a user's own private bot chat."""

    def __init__(
        self,
        enrollment_service: EnrollmentCancellation,
        messenger: MessageSender,
        *,
        bot_username: str | None = None,
    ) -> None:
        if bot_username is not None:
            bot_username = bot_username.removeprefix("@")
            if not bot_username or any(char.isspace() for char in bot_username):
                raise ValueError("bot_username must be a valid username")
        self._enrollment_service = enrollment_service
        self._messenger = messenger
        self._bot_username = bot_username

    async def handle(self, update: dict[str, Any]) -> bool:
        """Handle one Bot API update; return False when it is not a safe command."""
        message = update.get("message") if isinstance(update, dict) else None
        if not isinstance(message, dict):
            return False

        sender = message.get("from")
        chat = message.get("chat")
        text = message.get("text")
        if not isinstance(sender, dict) or not isinstance(chat, dict):
            return False

        owner_id = sender.get("id")
        chat_id = chat.get("id")
        if (
            isinstance(owner_id, bool)
            or not isinstance(owner_id, int)
            or owner_id <= 0
            or isinstance(chat_id, bool)
            or not isinstance(chat_id, int)
            or chat_id != owner_id
            or chat.get("type") != "private"
            or not isinstance(text, str)
        ):
            return False

        command = self._parse_command(text)
        if command is None:
            return False

        if command in ("/start", "/help"):
            await self._messenger.send_message(
                chat_id,
                "مدیریت اتصال حساب KageCatch\n"
                "/connect — راهنمای اتصال امن حساب\n"
                "/cancel — لغو درخواست اتصال در حال انتظار\n"
                "برای امنیت، کد ورود و رمز دومرحله‌ای را در این بات ارسال نکنید.",
            )
            return True

        if command == "/connect":
            await self._messenger.send_message(
                chat_id,
                "اتصال حساب فعلاً فعال نیست.\n"
                "چت خصوصی بات تلگرام رمزنگاری سرتاسری ندارد؛ "
                "بنابراین کد ورود یا رمز 2FA را اینجا ارسال نکنید.\n"
                "تا آماده‌شدن مسیر امن و ممیزی‌شده، ورود واقعی غیرفعال می‌ماند.",
            )
            return True

        if command == "/cancel":
            cancelled = await self._enrollment_service.cancel(owner_id)
            response = (
                "درخواست اتصال لغو شد."
                if cancelled
                else "درخواست اتصال فعالی برای لغو وجود ندارد."
            )
            await self._messenger.send_message(chat_id, response)
            return True

        return False

    def _parse_command(self, text: str) -> str | None:
        """Accept only exact supported commands and this bot's optional mention."""
        normalized = text.strip()
        if not normalized or any(char.isspace() for char in normalized):
            return None
        if "@" not in normalized:
            return normalized if normalized in {"/start", "/help", "/connect", "/cancel"} else None

        command, separator, username = normalized.partition("@")
        if (
            not separator
            or self._bot_username is None
            or username.casefold() != self._bot_username.casefold()
        ):
            return None
        return command if command in {"/start", "/help", "/connect", "/cancel"} else None
