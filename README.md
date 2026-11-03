# KageCatch

**KageCatch is a temporary project codename, not the final product name.**

Private, invite-only, multi-user Telegram character-catching automation.

## Current scope

The first foundation slice introduces isolated per-user control state and safety-gated Auto Catch toggles. Telegram session handling, command parsing, persistence, adapters, recognition, and catch execution are intentionally not implemented yet.

## Safety invariants

- A new user starts with Auto Catch disabled and all bot adapters paused.
- Global `.خاموش` pauses Auto Catch without disconnecting the Telegram listener or command processor.
- Global enablement does not implicitly enable any individual bot.
- Safety lock, exhausted quota, and FloodWait always override user enablement.
- Control state is scoped to one user; it must never be shared between users.

## Development

```bash
python -m pip install -e '.[dev]'
pytest
```
