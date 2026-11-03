# KageCatch

**KageCatch is a temporary project codename, not the final product name.**

Private, invite-only, multi-user Telegram character-catching automation.

## Current scope

The foundation provides isolated per-user control state, exact Persian command parsing, a control service, and a command router. Telegram session handling, persistence, bot adapters, recognition, and catch execution remain separate future layers.

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

## Safety invariants

- A new user starts with Auto Catch disabled and all bot adapters paused.
- Global .خاموش pauses Auto Catch without disconnecting the Telegram listener or command processor.
- Global enablement does not implicitly enable any individual bot.
- Safety lock, exhausted quota, and FloodWait always override user enablement.
- Control state is scoped to one user; it must never be shared between users.
- Unknown text is ignored and does not create user state.
- No Telegram session, credential, live catch action, merge, or deployment is part of this layer.

## Development

    python -m pip install -e '.[dev]'
    python -m pytest
    python -m compileall -q src tests
