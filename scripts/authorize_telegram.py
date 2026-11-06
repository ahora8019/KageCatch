"""Run this locally to authorize your own Telegram account.

Required environment variables:
  KAGECATCH_API_ID
  KAGECATCH_API_HASH
  KAGECATCH_FERNET_KEY
  KAGECATCH_USER_ID

The phone number, login code, and optional 2FA password are entered only in
this local terminal. Never paste them into ChatGPT, a Telegram bot, GitHub, or
a ticket. Do not commit the generated SQLite database.
"""
from __future__ import annotations

import asyncio
import getpass
import os
import sys

from telethon import TelegramClient
from telethon.sessions import StringSession

from kagecatch.session_manager import SessionManager
from kagecatch.sqlite_session_store import SQLiteSessionStore
from kagecatch.telegram_authorization import authorize_telethon_session


async def main() -> int:
    required = ("KAGECATCH_API_ID", "KAGECATCH_API_HASH", "KAGECATCH_FERNET_KEY", "KAGECATCH_USER_ID")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print("Missing required environment configuration: " + ", ".join(missing), file=sys.stderr)
        return 2

    try:
        api_id = int(os.environ["KAGECATCH_API_ID"])
    except ValueError:
        print("KAGECATCH_API_ID must be an integer.", file=sys.stderr)
        return 2

    phone = input("Your Telegram phone number (international format): ").strip()
    if not phone:
        print("Phone number is required.", file=sys.stderr)
        return 2

    database_path = os.environ.get("KAGECATCH_SESSION_DB", "data/kagecatch-sessions.sqlite3")
    store = SQLiteSessionStore(database_path)
    manager = SessionManager(
        fernet_key=os.environ["KAGECATCH_FERNET_KEY"],
        store=store,
    )
    client = TelegramClient(
        StringSession(),
        api_id,
        os.environ["KAGECATCH_API_HASH"],
    )
    await client.connect()
    try:
        await authorize_telethon_session(
            client=client,
            user_id=os.environ["KAGECATCH_USER_ID"],
            phone=phone,
            code_provider=lambda: _secret_prompt("Telegram login code: "),
            password_provider=lambda: _secret_prompt("Telegram two-step verification password: "),
            session_manager=manager,
        )
    except Exception:
        print("Telegram authorization failed. No session was confirmed as saved.", file=sys.stderr)
        return 1

    print("Telegram account authorized. Encrypted session saved locally.")
    print("Keep the database and Fernet key private; do not commit or upload either.")
    return 0


async def _secret_prompt(label: str) -> str:
    return await asyncio.to_thread(getpass.getpass, label)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
