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
- **Execution Plane:** Python core, designed for authorized per-user Telethon sessions.
- **Recognition:** Spawn ingestion, image/video analysis, reference-catalog search, candidate ranking, and confidence gating.
- **Catch Engine:** Quota check, duplicate suppression, adapter-specific command dispatch, and verification against the target bot response.

## Repository status

The Python Catch Engine foundation is in `kagecatch/engine.py`. It accepts normalized spawn candidates, blocks low-confidence matches, checks a quota interface, deduplicates events, dispatches through an adapter interface, and reports success only after adapter verification. Source command configuration is in `kagecatch/adapters.py`.

The current in-memory deduplicator is for development only. Persistent quota/deduplication, encrypted user-session authorization, actual Telethon adapters, spawn recognition, and the Worker-to-Python queue connection remain unimplemented. No real catch commands are sent by this foundation.

## Development

Python 3.11+ is required. Run tests with:

```bash
python -m unittest discover -s tests -v
```

GitHub Actions runs the same unit test suite for feature branches and pull requests.

See [Catch Engine design](docs/CATCH_ENGINE.md) for the current scope and integration sequence.
