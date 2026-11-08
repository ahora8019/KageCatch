# KageCatch

Role-based multi-user Telegram character spawn recognition and catch orchestration. New users require an Owner-issued invitation before they can join. Existing members remain registered, and the configured numeric Telegram ID is always resolved as OWNER.

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
- `kagecatch/sqlite_session_store.py`: local single-host SQLite fallback for encrypted blobs.
- `kagecatch/d1_session_store.py`: signed HTTPS adapter that transports encrypted blobs through the Cloudflare Control Worker into D1; it never stores plaintext sessions or needs a Cloudflare API token in Render.
- `migrations/0001_telegram_sessions.sql`: D1 schema for encrypted session blobs.
- `wrangler.toml`: preview D1 binding and the existing Durable Object namespace.
- `kagecatch/session_runtime.py`: isolated per-user Telethon clients, authorization checks, disconnect and revocation.
- `kagecatch/telegram_authorization.py`: local interactive authorization helper.
- `kagecatch/telegram_auth_flow.py`: isolated phone-code authorization state machine; do not expose its OTP/2FA inputs through the bot.
- `kagecatch/telegram_qr_auth_flow.py`: Telegram-native one-time `tg://login?token=...` deep-link authorization; no QR image and no OTP/2FA collection.

The authorization state machine is isolated from the bot transport and must never collect OTP/2FA values in the Telegram chat. The Control Worker issues short-lived, one-time account links through the `CONNECT_LINKS` Durable Object (`ConnectionLinkStore`). The link is exchanged once for a random browser session token; only its SHA-256 digest and Telegram user binding are stored in the Durable Object, and the browser token expires after ten minutes. The standalone HTTPS login page at `/connect/{token}` collects phone, OTP, and optional 2FA only in the browser, then forwards them through a bearer-authenticated Worker endpoint to the HMAC-signed Python Core API. The page uses no third-party scripts, no-store caching, a restrictive Content Security Policy, and clears the one-time token from browser history after exchange. Bot account-connect callbacks now send a normal HTTPS URL button instead of launching the Mini App. Real-account validation remains pending; no live catch has been performed.

## Legacy Telegram Mini App

The previous dashboard remains available at `/panel` temporarily as a fallback while the standalone login flow is reviewed and tested. It is no longer the default account-connection path. Do not remove the legacy route until the standalone login is deployed, verified end-to-end, and the user explicitly approves retiring it.

See [Professional Panel and Core Roadmap](docs/PRO_PANEL_AND_CORE_ROADMAP.md).

## Durable group panel queue

Group commands `.panel` and `.پنل` are accepted only from the authorized account owner in a group/supergroup. The Python Core sends a timestamped HMAC-signed request to `POST /internal/panel-requests`; the Worker stores it in the independent `panel_requests` D1 table with a deterministic idempotency key. The scheduled Worker claims pending requests, sends the Control Bot panel into the exact source group, and stores the resulting message ID. Abandoned claims are recovered after two minutes and delivery attempts are bounded to three.

Every callback is bound to the stored request, owner Telegram ID, exact group ID, exact panel message ID, and active expiry. Non-owners receive an alert. Catch remains disabled in the panel; buttons currently expose status/configuration placeholders only.

The schema is in `migrations/0002_panel_requests.sql`. The additive table has been created in the existing `kagecatch-sessions-preview` D1 database; the existing `telegram_sessions` table was not modified. The Core uses `KAGECATCH_PANEL_QUEUE_URL`, falling back to `KAGECATCH_SESSION_STORE_URL`, and the existing `KAGECATCH_CORE_SECRET` for HMAC signing. The Worker route and scheduled delivery code are committed but not deployed. Do not enable real group delivery until the Worker deployment and a controlled test group verification are explicitly approved.

## Durable session storage (Cloudflare D1)

The preview D1 database is `kagecatch-sessions-preview` in the EU jurisdiction, primary region EEUR. It stores only Fernet-encrypted Telethon StringSession ciphertext. The Python Core encrypts before the request; the Worker accepts only HMAC-authenticated requests signed with the existing Core shared secret, checks timestamp and a Durable Object-backed one-time nonce, then uses parameterized D1 statements.

The Python Core selects this adapter when `KAGECATCH_SESSION_STORE_URL` is configured (set it to the Control Worker origin). The Worker must have the `KAGECATCH_DB` D1 binding and the existing `CONNECT_LINKS` Durable Object binding. Without the URL, local development retains the SQLite fallback.

The D1 database and schema are provisioned for preview, but the Worker binding and new Worker code have **not** been deployed. Render environment variables have not been changed. Do not authorize a real Telegram account until the Worker binding is deployed, the D1 adapter passes live round-trip tests, and the Fernet key exposed in the development conversation has been rotated.

## Control bot roles

`worker/index.mjs` defines a role-based access model. The numeric ID configured in the `OWNER_TELEGRAM_ID` Worker secret is always resolved as `OWNER`; existing registered members retain `MEMBER`. New users must redeem a short-lived Owner-issued invite link (`/start inv_…`) before they are registered. Invites are stored by token digest, have bounded use counts and expiry, and can be revoked. Members see only personal account, security, and statistics controls. The Owner receives the member list, block/unblock controls, invite management, system overview, and broadcast. Global settings and emergency-stop actions remain unfinished placeholders. Role checks run again on every callback; blocked users are denied. `/admin` is Owner-only. `OWNER_TELEGRAM_ID` must remain a Cloudflare Secret and must never be committed to the repository. Never ask users to send Telegram login codes or 2FA passwords to the bot.

## Development

Python 3.11+ is required. Install the Telegram integration and run tests with:

    python -m pip install '.[telegram,api]'
    python -m unittest discover -s tests -v

Before authorizing an account, configure `KAGECATCH_API_ID`, `KAGECATCH_API_HASH`, and `KAGECATCH_FERNET_KEY` in the Python host's secret manager. Configure `KAGECATCH_CORE_SECRET` there and set the matching `CORE_API_URL` and `CORE_API_SECRET` as Worker secrets.

Run the Python Core API with `uvicorn kagecatch.core_api:app --host 0.0.0.0 --port 8000` after configuring `KAGECATCH_CORE_SECRET`, `KAGECATCH_API_ID`, `KAGECATCH_API_HASH`, and `KAGECATCH_FERNET_KEY` as deployment secrets. Set `KAGECATCH_DB_PATH` to a durable mounted path. Set `CORE_API_URL` and the same secret value as `CORE_API_SECRET` in Cloudflare. The Worker signs every Core request with timestamp, nonce, method, path, and body hash. The initial replay guard is single-process; do not scale the Core API horizontally until a shared nonce store is configured.

See [Catch Engine and Session Runtime design](docs/CATCH_ENGINE.md) for security boundaries and remaining work.
