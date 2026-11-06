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

The authorization state machine is isolated from the bot transport and must not be exposed as a chat-based OTP/2FA collection flow. The Control Worker now issues short-lived, one-time connection links through a Durable Object. Link consumption only proves possession of the link; it does not authorize a Telegram account or create a Telethon session. The Durable Object binding is `CONNECT_LINKS` and the exported class is `ConnectionLinkStore`. The reviewed Control Worker source is in `worker/index.mjs`; it provides an inline-first menu and deliberately refuses to collect Telegram login codes or 2FA passwords. The role-aware menu was deployed in 0.5.0 and the broadcast workflow in 0.6.0. The authenticated Worker-to-Python Core API bridge is implemented in the 0.7.0 development branch, but no Python execution host or Core secrets are configured yet. A secure Telegram-controlled account authorization handoff and real-account validation remain pending; no live catch has been performed.

## Professional Telegram Mini App

The Worker serves a mobile-first Persian RTL dashboard at `/panel`. Member and Owner bot menus expose it through an inline Web App button. The Mini App posts Telegram `initData` to `/api/session`; the Worker verifies the HMAC-SHA-256 signature and a five-minute freshness window, then resolves the role from the server-side Durable Object registry. The browser cannot assign itself OWNER. The current UI is a product foundation. The Worker now has signed Core health/account status, disconnect, and revoke routes; these remain unavailable until a Python Core host and matching `CORE_API_URL` / `CORE_API_SECRET` are configured. Account authorization, Catch settings, and activity APIs are still pending.

See [Professional Panel and Core Roadmap](docs/PRO_PANEL_AND_CORE_ROADMAP.md).

## Control bot roles

`worker/index.mjs` defines a Ronin-style role model. `/start` registers a Telegram user as `MEMBER` by default; the numeric ID configured in the `OWNER_TELEGRAM_ID` Worker secret is always resolved as `OWNER`. Members see only personal account, security, and statistics controls. The Owner receives global monitoring, member list, block/unblock controls, global settings, broadcast, and emergency-stop controls. Role checks run again on every callback; blocked users are denied. `/admin` is Owner-only. Configure `OWNER_TELEGRAM_ID` before deploying this role-aware source. Never ask users to send Telegram login codes or 2FA passwords to the bot.

## Development

Python 3.11+ is required. Install the Telegram integration and run tests with:

    python -m pip install '.[telegram,api]'
    python -m unittest discover -s tests -v

Before authorizing an account, configure `KAGECATCH_API_ID`, `KAGECATCH_API_HASH`, and `KAGECATCH_FERNET_KEY` in the Python host's secret manager. Configure `KAGECATCH_CORE_SECRET` there and set the matching `CORE_API_URL` and `CORE_API_SECRET` as Worker secrets.

Run the Python Core API with `uvicorn kagecatch.core_api:app --host 0.0.0.0 --port 8000` after configuring `KAGECATCH_CORE_SECRET`, `KAGECATCH_API_ID`, `KAGECATCH_API_HASH`, and `KAGECATCH_FERNET_KEY` as deployment secrets. Set `CORE_API_URL` and the matching `CORE_API_SECRET` in the Worker environment. The Worker signs every Core request with timestamp, nonce, method, path, and body hash. The initial replay guard is single-process; do not scale the Core API horizontally until a shared nonce store is configured.

See [Catch Engine and Session Runtime design](docs/CATCH_ENGINE.md) for security boundaries and remaining work.
