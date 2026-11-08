"""Per-account Telethon listeners and safe dot-command triggers.

The in-chat panel is requested through an injected durable requester. Telethon
never sends inline keyboards for the bot-owned panel: the Control Bot owns that
UI and its callback lifecycle.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any


PanelRequester = Callable[..., Awaitable[dict[str, Any]]]


class TelegramSelfbotController:
    def __init__(
        self,
        *,
        incoming_handler=None,
        panel_image_url: str | None = None,
        panel_requester: PanelRequester | None = None,
    ) -> None:
        self.enabled_users: set[str] = set()
        self.incoming_event_counts: dict[str, int] = {}
        self._incoming_handler = incoming_handler
        self._panel_image_url = panel_image_url
        self._panel_requester = panel_requester

    def set_incoming_handler(self, handler) -> None:
        if handler is not None and not callable(handler):
            raise TypeError("incoming handler must be callable or None")
        self._incoming_handler = handler

    def set_panel_requester(self, requester: PanelRequester | None) -> None:
        if requester is not None and not callable(requester):
            raise TypeError("panel requester must be callable or None")
        self._panel_requester = requester

    def is_enabled(self, user_id: str) -> bool:
        return user_id in self.enabled_users

    def set_enabled(self, user_id: str, enabled: bool) -> bool:
        if enabled:
            self.enabled_users.add(user_id)
        else:
            self.enabled_users.discard(user_id)
        return self.is_enabled(user_id)

    async def attach(self, client, user_id: str) -> None:
        try:
            from telethon import Button, events
        except ImportError as exc:
            raise RuntimeError("install KageCatch with the telegram extra") from exc

        async def incoming(event):
            self.incoming_event_counts[user_id] = self.incoming_event_counts.get(user_id, 0) + 1
            if self._incoming_handler is not None:
                result = self._incoming_handler(user_id, event)
                if hasattr(result, "__await__"):
                    await result

        async def outgoing(event):
            command = (getattr(event, "raw_text", "") or "").strip()
            if command in {".panel", ".پنل"}:
                await self._request_in_chat_panel(event, user_id)
                return

            # Existing local dot commands remain restricted to Saved Messages.
            if not getattr(event, "is_private", False):
                return
            if str(getattr(event, "chat_id", "")) != user_id:
                return
            if command == ".روشن":
                self.set_enabled(user_id, True)
                await event.respond("🟢 حالت Catch روشن شد؛ اجرای واقعی بعد از اتصال Spawn Detector و Recognition Engine فعال می‌شود. برای توقف، .خاموش را بفرست.")
            elif command == ".خاموش":
                self.set_enabled(user_id, False)
                await event.respond("⏸ حالت Catch خاموش شد؛ هیچ Catch جدیدی از این حالت اجرا نمی‌شود.")

        async def callback(event):
            # Legacy callbacks remain scoped to Saved Messages only.
            if str(getattr(event, "sender_id", "")) != user_id:
                return
            if str(getattr(event, "chat_id", "")) != user_id:
                return
            data = bytes(getattr(event, "data", b"")).decode("utf-8", "ignore")
            if data == "kagecatch:enable":
                self.set_enabled(user_id, True)
                await event.answer("حالت روشن شد؛ موتور Catch هنوز آماده اجرا نیست")
                await event.edit(self._panel_text(user_id), buttons=[
                    [Button.inline("⏸ خاموش کردن Catch", b"kagecatch:disable")],
                    [Button.inline("📊 وضعیت", b"kagecatch:status")],
                ])
            elif data == "kagecatch:disable":
                self.set_enabled(user_id, False)
                await event.answer("Catch خاموش شد")
                await event.edit(self._panel_text(user_id), buttons=[
                    [Button.inline("🌸 روشن کردن Catch", b"kagecatch:enable")],
                    [Button.inline("📊 وضعیت", b"kagecatch:status")],
                ])
            elif data == "kagecatch:status":
                await event.answer(
                    "روشن" if self.is_enabled(user_id) else "خاموش",
                    alert=True,
                )

        client.add_event_handler(incoming, events.NewMessage(incoming=True))
        client.add_event_handler(outgoing, events.NewMessage(outgoing=True))
        client.add_event_handler(callback, events.CallbackQuery)

    async def _request_in_chat_panel(self, event, user_id: str) -> None:
        # NewMessage(outgoing=True) is the primary sender check; verify identity
        # again so test doubles or future handler reuse cannot spoof the owner.
        sender_id = getattr(event, "sender_id", None)
        try:
            expected_sender = int(user_id)
        except (TypeError, ValueError):
            return
        if sender_id != expected_sender or getattr(event, "out", True) is False:
            return

        # Initially support groups/supergroups only. Broadcast channels and
        # private chats are intentionally excluded until their permissions are verified.
        is_group = bool(getattr(event, "is_group", False))
        is_channel = bool(getattr(event, "is_channel", False))
        is_broadcast = bool(getattr(event, "is_broadcast", False))
        if not is_group or is_broadcast or (is_channel and not is_group):
            return

        chat_id = getattr(event, "chat_id", None)
        message_id = getattr(event, "id", None)
        if (
            isinstance(chat_id, bool) or not isinstance(chat_id, int)
            or isinstance(message_id, bool) or not isinstance(message_id, int)
            or message_id <= 0
        ):
            return
        if self._panel_requester is None:
            await event.respond("⚠️ سرویس ساخت پنل فعلاً پیکربندی نشده؛ پیام فرمان حذف نشد.")
            return

        try:
            result = await self._panel_requester(
                owner_id=user_id,
                chat_id=chat_id,
                source_message_id=message_id,
            )
        except Exception:
            await event.respond("⚠️ درخواست پنل ثبت نشد؛ دوباره تلاش کن.")
            return

        if not isinstance(result, dict) or result.get("accepted") is not True:
            await event.respond("⚠️ درخواست پنل تأیید نشد؛ پیام فرمان حذف نشد.")
            return

        # Delete only after durable acceptance has been acknowledged.
        try:
            await event.delete()
        except Exception:
            # The accepted task remains idempotent; a failed delete must not
            # cancel or duplicate panel creation.
            pass

    def _panel_text(self, user_id: str) -> str:
        status = "🟢 روشن" if self.is_enabled(user_id) else "⚪ خاموش"
        return (
            "🌸 KageCatch — پنل سلف\n"
            "━━━━━━━━━━━━━━\n"
            f"وضعیت Catch: {status}\n"
            "حساب: متصل\n"
            "موتور Catch: در انتظار اتصال Spawn Detector\n\n"
            "این پنل قدیمی فقط در Saved Messages قابل استفاده است."
        )
