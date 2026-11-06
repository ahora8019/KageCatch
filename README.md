# KageCatch

Private, invite-only, multi-user Telegram character spawn recognition and catch orchestration.

## Supported catcher targets

| Target | Media | Catch command | State |
|---|---|---|---|
| SenpaiCatcherBot | Video | `/pick {name}` | Frozen / unavailable; retained in architecture |
| HentaCatcherBot | Image | `/catch {name}` | Configured |
| Character_Catcher_Bot | Image | `/catch {name}` | Configured |

## Architecture

- **Control Plane:** Cloudflare Worker + Telegram Bot API for commands and user-facing control.
- **Execution Plane:** Python core with encrypted per-user Telethon sessions.
- **Recognition:** Planned spawn ingestion, image/video analysis, reference-catalog search, candidate ranking, and confidence gating.
- **Catch Engine:** Quota check, duplicate suppression, adapter-specific command dispatch, and verification against the target bot response.

## Repository status

The Catch Engine foundation is in `kagecatch/engine.py`. It accepts normalized spawn candidates, blocks low-confidence matches, checks a quota interface, deduplicates events, dispatches through an adapter interface, and reports success only after adapter verification.

Session components:
- `kagecatch/session_manager.py`: Fernet encryption/decryption boundary.
- `kagecatch/sqlite_session_store.py`: single-host SQLite persistence for encrypted blobs.
- `kagecatch/session_runtime.py`: isolated per-user Telethon clients, authorization checks, disconnect and revocation.
- `kagecatch/telegram_authorization.py`: local interactive authorization helper.
- `kagecatch/telegram_auth_flow.py`: short-lived, per-user bot-driven authorization state machine (5-minute TTL, 3 attempts, optional 2FA, cancellation).

The authorization state machine is isolated from the bot transport and must not be exposed as a chat-based OTP/2FA collection flow. The Control Worker now issues short-lived, one-time connection links through a Durable Object. Link consumption only proves possession of the link; it does not authorize a Telegram account or create a Telethon session. The Durable Object binding is `CONNECT_LINKS` and the exported class is `ConnectionLinkStore`. The reviewed Control Worker source is in `worker/index.mjs`; it provides an inline-first menu and deliberately refuses to collect Telegram login codes or 2FA passwords. The menu is not yet deployed. A secure local authorization handoff, authenticated Worker-to-Python API, production execution host, and real-account validation remain pending. No production Worker deployment or live catch has been performed.

## Control bot interface\n\n`worker/index.mjs` contains the reviewed Cloudflare Worker source. The menu is inline-first; `/status`, `/help`, and `/admin` remain secondary shortcuts. `/admin` is intentionally disabled until an owner identity and authorization policy are configured. Account connection is intentionally unavailable until a secure handoff is implemented; never ask users to send Telegram login codes or 2FA passwords to the bot.\n\n## Development

Python 3.11+ is required. Install the Telegram integration and run tests with:

    python -m pip install '.[telegram]'
    python -m unittest discover -s tests -v

Before authorizing an account, configure these environment secrets: `KAGECATCH_API_ID`, `KAGECATCH_API_HASH`, `KAGECATCH_FERNET_KEY`, and `KAGECATCH_USER_ID`.

See [Catch Engine and Session Runtime design](docs/CATCH_ENGINE.md) for security boundaries and remaining work.
