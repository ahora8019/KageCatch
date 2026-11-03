# KageCatch

**KageCatch is a temporary project codename, not the final product name.**

Private, invite-only, multi-user Telegram character-catching automation.

## Current architecture

- **Control Plane:** Cloudflare Worker receives Telegram Bot API webhooks, validates Telegram's webhook secret header, answers basic bot commands, and serves the web control-status page at `/panel`.
- **Execution Plane:** Python Core is a separate service. It will own Telethon/MTProto sessions, Saved Messages listener processing, per-user isolation, queues, and catch execution.
- The Worker does not replace Telethon and does not execute catch actions.

## Control Bot commands

- `/start` — welcome message.
- `/panel` and `/status` — current Control Plane status and explicit Python Core connectivity state.
- `/help` — supported commands.

The web status panel is available at `/panel` on the Worker domain. It does not expose private messages, session data, or credentials.

## Python self-control commands

These commands are intended to be invoked only after the Telegram integration validates that a message is an outgoing message from the authenticated account in Saved Messages.

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

The Python router does not perform Telegram authorization itself. Its caller must apply the Saved Messages access guard before forwarding a command.

## Safety invariants

- A new user starts with Auto Catch disabled and all bot adapters paused.
- Global .خاموش pauses Auto Catch without disconnecting the Telegram listener or command processor.
- Global enablement does not implicitly enable any individual bot.
- Safety lock, exhausted quota, and FloodWait always override user enablement.
- Control state is scoped to one user; it must never be shared between users.
- Unknown text is ignored and does not create user state.
- No Telegram session, credential, live catch action, merge, or production trading action is part of this layer.

## Worker development and tests

    node --test worker/test/*.test.js

## Python development and tests

    python -m pip install -e '.[dev]'
    python -m pytest
    python -m compileall -q src tests

## Deployment

The Worker requires the Cloudflare secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`. Never commit their values. The Python Core is not yet connected; the control bot must report that state honestly.
