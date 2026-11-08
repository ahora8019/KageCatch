"""Per-account Telethon listeners and self-account dot commands.

Commands are handled only on the authorized account's own outgoing messages.
The controller toggles a per-user Catch intent flag; it does not send catch
commands to target bots. Spawn processing is supplied separately.
"""
from __future__ import annotations


class TelegramSelfbotController:
    def __init__(self, *, incoming_handler=None, panel_image_url: str | None = None) -> None:
        self.enabled_users: set[str] = set()
        self.incoming_event_counts: dict[str, int] = {}
        self._incoming_handler = incoming_handler
        self._panel_image_url = panel_image_url

    def set_incoming_handler(self, handler) -> None:
        if handler is not None and not callable(handler):
            raise TypeError("incoming handler must be callable or None")
        self._incoming_handler = handler

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
            if not getattr(event, "is_private", False):
                return
            if str(getattr(event, "chat_id", "")) != user_id:
                return
            command = (getattr(event, "raw_text", "") or "").strip()
            if command == ".پنل":
                buttons = [
                    [Button.inline("🌸 روشن کردن Catch", b"kagecatch:enable")],
                    [Button.inline("⏸ خاموش کردن Catch", b"kagecatch:disable")],
                    [Button.inline("📊 وضعیت", b"kagecatch:status")],
                ]
                caption = self._panel_text(user_id)
                if self._panel_image_url:
                    await client.send_file(
                        event.chat_id,
                        self._panel_image_url,
                        caption=caption,
                        buttons=buttons,
                    )
                else:
                    await event.respond(caption, buttons=buttons)
            elif command == ".روشن":
                self.set_enabled(user_id, True)
                await event.respond("🟢 حالت Catch روشن شد؛ اجرای واقعی بعد از اتصال Spawn Detector و Recognition Engine فعال می‌شود. برای توقف، .خاموش را بفرست.")
            elif command == ".خاموش":
                self.set_enabled(user_id, False)
                await event.respond("⏸ حالت Catch خاموش شد؛ هیچ Catch جدیدی از این حالت اجرا نمی‌شود.")

        async def callback(event):
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

    def _panel_text(self, user_id: str) -> str:
        status = "🟢 روشن" if self.is_enabled(user_id) else "⚪ خاموش"
        return (
            "🌸 KageCatch — پنل سلف\n"
            "━━━━━━━━━━━━━━\n"
            f"وضعیت Catch: {status}\n"
            "حساب: متصل\n"
            "موتور Catch: در انتظار اتصال Spawn Detector\n\n"
            "از دکمه‌ها برای کنترل حالت Catch استفاده کن. "
            "این پنل فقط روی پیام‌های خودت در Saved Messages کار می‌کند."
        )
