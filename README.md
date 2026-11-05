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
- `kagecatch/telegram_authorization.py`: explicit authorization flow.
- `scripts/authorize_telegram.py`: local interactive command; login code and optional 2FA password are entered locally, never through the bot.

A real-account authorization test has not yet been run. The owner must execute the local CLI in a private environment and supply Telegram verification details directly to that terminal. No production Worker deployment or live catch has been performed.

## Development

Python 3.11+ is required. Install the Telegram integration and run tests with:

    python -m pip install '.[telegram]'
    python -m unittest discover -s tests -v

Before authorizing an account, configure these environment secrets: `KAGECATCH_API_ID`, `KAGECATCH_API_HASH`, `KAGECATCH_FERNET_KEY`, and `KAGECATCH_USER_ID`.

See [Catch Engine and Session Runtime design](docs/CATCH_ENGINE.md) for security boundaries and remaining work.
