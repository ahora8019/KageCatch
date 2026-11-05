# KageCatch

Private, invite-only, multi-user Telegram character spawn recognition and catch orchestration.

## Supported catcher targets

| Target | Media | Catch command | State |
|---|---|---|---|
| SenpaiCatcherBot | Video | /pick {name} | Frozen / unavailable; retained in architecture |
| HentaCatcherBot | Image | /catch {name} | Configured |
| Character_Catcher_Bot | Image | /catch {name} | Configured |

## Architecture

- **Control Plane:** Cloudflare Worker + Telegram Bot API for commands and user-facing control.
- **Execution Plane:** Python core with encrypted per-user Telethon sessions.
- **Recognition:** Planned spawn ingestion, image/video analysis, reference-catalog search, candidate ranking, and confidence gating.
- **Catch Engine:** Quota check, duplicate suppression, adapter-specific command dispatch, and verification against the target bot response.

## Repository status

The Python Catch Engine foundation is in kagecatch/engine.py. It accepts normalized spawn candidates, blocks low-confidence matches, checks a quota interface, deduplicates events, dispatches through an adapter interface, and reports success only after adapter verification.

Session storage and runtime foundations are in kagecatch/session_manager.py and kagecatch/session_runtime.py. Sessions are Fernet-encrypted behind a storage interface. The runtime reconnects only previously authorized StringSessions, isolates clients per KageCatch user, checks Telegram authorization, and supports disconnect/revocation. It does not implement interactive login or request login codes/2FA passwords.

Persistent storage, key rotation, initial user authorization, real Telegram response listeners, spawn recognition, persistent quota/deduplication, and the Worker-to-Python queue connection remain incomplete. No production Worker deployment or live catch was performed.

## Development

Python 3.11+ is required. Install the Telegram integration and run tests with:

    python -m pip install '.[telegram]'
    python -m unittest discover -s tests -v

GitHub Actions runs the same unit test suite for feature branches and pull requests.

See docs/CATCH_ENGINE.md for current scope and remaining integration work.
