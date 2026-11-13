"""Explicit interactive authorization for a user's own Telegram account.

Callers must collect phone codes and 2FA passwords through a private local
prompt, never through a Telegram bot, logs, chat, or a web form.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from telethon.errors import SessionPasswordNeededError


class AuthorizedSessionManager(Protocol):
    async def save_authorized_session(self, user_id: str, session_string: str) -> None: ...


SecretProvider = Callable[[], Awaitable[str]]


async def authorize_telethon_session(
    *,
    client,
    user_id: str,
    phone: str,
    code_provider: SecretProvider,
    password_provider: SecretProvider,
    session_manager: AuthorizedSessionManager,
) -> None:
    if not user_id or len(user_id) > 128:
        raise ValueError("valid user_id is required")
    if not phone or not phone.strip():
        raise ValueError("phone number is required")
    try:
        sent_code = await client.send_code_request(phone.strip())
        code = await code_provider()
        if not code or not code.strip():
            raise ValueError("Telegram login code is required")

        try:
            await client.sign_in(
                phone=phone.strip(),
                code=code.strip(),
                phone_code_hash=sent_code.phone_code_hash,
            )
        except SessionPasswordNeededError:
            password = await password_provider()
            if not password:
                raise ValueError("Telegram 2FA password is required")
            await client.sign_in(password=password)

        if not await client.is_user_authorized():
            raise PermissionError("Telegram did not authorize this account")

        session_string = client.session.save()
        if not session_string:
            raise RuntimeError("Telethon did not produce a reusable session")
        await session_manager.save_authorized_session(user_id, session_string)
    except BaseException:
        try:
            await client.disconnect()
        except Exception:
            pass
        raise
    else:
        await client.disconnect()
