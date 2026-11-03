# KageCatch

**KageCatch is a temporary project codename, not the final product name.**

Private, invite-only, multi-user Telegram character-catching automation.

## Current scope

The Python foundation provides isolated per-user control state, exact Persian command parsing, a control service, a command router, per-account async session lifecycle management, encrypted session-string storage, and an optional Telethon adapter.

Live Catch/Pick execution, persistent job queues, real-time Listener routing, and account enrollment/login are not implemented yet.

## Self-control commands

Commands are intended to be invoked only after the Telegram integration validates that a message is an outgoing message from the authenticated account in Saved Messages.

- .پنل — show the control panel.
- .روشن — enable global Auto Catch; it does not enable individual bots.
- .خاموش — pause global Auto Catch while leaving the Listener/command path available.
- .وضعیت — show global and per-bot state.
- .بات‌ها — show per-bot state.
- .آمار and .سهمیه — reserved responses until statistics and quota services are implemented.
- .راهنما — show supported commands.
- .روشن سنپای, .خاموش سنپای — toggle Senpai independently.
- .روشن هنتا, .خاموش هنتا — toggle Henta independently.
- .روشن کاراکتر, .خاموش کاراکتر — toggle Character independently.

The router does not perform Telegram authorization itself. Its caller must apply the Saved Messages access guard before forwarding a command.

## Telegram session foundation

Install the optional Telegram adapter dependency:

    python -m pip install -e '.[dev,telegram]'

The session store encrypts Telethon StringSession values using Fernet. The encryption key must be provided by an external secret manager or environment variable; KageCatch does not generate or persist that key.

Example configuration (the account must already have an enrolled authorized session; enrollment is a separate future workflow):

    import os
    from pathlib import Path
    from kagecatch.runtime import EncryptedFileSessionStore, SessionManager, TelethonSessionFactory

    store = EncryptedFileSessionStore(
        Path(os.environ["KAGECATCH_SESSION_DIR"]),
        os.environ["KAGECATCH_SESSION_KEY"],
    )
    factory = TelethonSessionFactory(
        api_id=int(os.environ["TELEGRAM_API_ID"]),
        api_hash=os.environ["TELEGRAM_API_HASH"],
        session_store=store,
    )
    manager = SessionManager(factory)

Storage safeguards:
- One encrypted file per account; filenames are SHA-256 digests of account identifiers.
- On POSIX systems, the storage directory is restricted to mode 0700 and session files to 0600.
- Writes use a temporary file and atomic replacement.
- The Fernet key is not written to disk or included in logs.
- A missing or unauthorized session fails closed; the adapter does not start an interactive login flow.
- Do not commit session files, API credentials, encryption keys, or exported session strings.

The adapter only connects an already-enrolled authorized session and persists refreshed session strings. It does not automate login, send messages, monitor target bots, or execute Catch/Pick actions.

## Safety invariants

- A new user starts with Auto Catch disabled and all bot adapters paused.
- Global .خاموش pauses Auto Catch without disconnecting the Telegram listener or command processor.
- Global enablement does not implicitly enable any individual bot.
- Safety lock, exhausted quota, and FloodWait always override user enablement.
- Control state is scoped to one user; it must never be shared between users.
- Unknown text is ignored and does not create user state.
- No live Catch/Pick execution, queue, Listener integration, merge, or production deployment is part of this foundation.

## Development

    python -m pip install -e '.[dev]'
    python -m pytest
    python -m compileall -q src tests
