# KageCatch

KageCatch is a Telegram-first, multi-user character-spawn recognition and manual-review system. New users require an Owner-issued invitation. The configured numeric Telegram user ID is the only Owner identity.

## Telegram-only control surface

All user and Owner controls are delivered inside the Telegram bot. The web dashboard, Telegram Mini App, browser login page, one-time login links, and browser account APIs are retired. `GET /panel` and the former Mini App/account routes return `404`. `/panel` remains only as a Telegram slash-command shortcut that opens the bot's inline menu; it is not a web page.

### Native account login

The private bot conversation uses this flow:

1. Enter the phone number in international E.164 format.
2. Enter the Telegram login code using the bot's inline numeric keypad.
3. Enter the 2FA password only if Telegram requests it.

OTP digits are not embedded in callback data. Short-lived authorization state is encrypted and bound to the Telegram user ID. The bot attempts to delete phone/code/password messages, but deletion is best-effort. Telegram bot chats are not end-to-end encrypted, so credentials transit the bot backend; never send credentials to anyone other than the official KageCatch bot.

## Architecture

- **Control Plane:** Cloudflare Worker, Telegram Bot API, Durable Objects, and D1.
- **Execution Plane:** Python Core with per-user Telethon sessions encrypted before persistence.
- **Recognition:** sender/media/phrase-gated spawn detection, frame extraction, anime matching, and conservative character resolution.
- **Manual Review:** user-scoped review records with expiry, approval/rejection, and retry-safe persistence.
- **Catch Engine:** guarded adapter interface with atomic admission, quota, deduplication, and receipt verification.

For the approved SenpaiCatcher recognition path, only an extracted frame from a qualifying Spawn video may be sent to `trace.moe`; the full video is not uploaded.

## Recognition job queue

`kagecatch/job_queue.py` provides a single-host SQLite queue with typed claims, priorities, delayed scheduling, idempotency keys, bounded retries, dead-letter quarantine, fenced lease generations, lease renewal, and expired-lease recovery.

The Core starts the recognition worker only when all required components are configured and `KAGECATCH_JOB_QUEUE_PATH` points to a persistent local database path. The worker claims only `spawn.recognize` jobs. Jobs are created from an already-detected Spawn on the manual-review path; the queue is not attached to raw Telegram ingress and never issues Catch commands. D1 review creation uses deterministic review IDs so a retry after a lost acknowledgement does not create duplicate review records.

**Storage limitation:** this SQLite queue is single-host, not distributed. Its database must live on persistent local storage; an ephemeral container filesystem is not sufficient. Leave `KAGECATCH_JOB_QUEUE_PATH` unset until the Python host has durable storage. The queue is optional and is not activated merely by deploying the code.

## Catch execution safety

All configured Catch targets are registered but disabled. `CatchEngine` is disabled by default, and `build_catch_command()` refuses to build commands while a target is disabled. No real Catch command may be enabled until its exact syntax is explicitly approved and a controlled test is separately authorized. Recognition and manual review do not imply permission to execute Catch.

## Telegram Owner controls

The Owner's private bot menu includes member administration, invitations, activity/status monitoring, broadcast draft/preview/confirmation, an emergency-stop placeholder, and Telegram send-safety monitoring/recovery. Safety recovery is performed in the Telegram bot with a separate confirmation and stale-state checks; there is no web Owner panel. Role checks are repeated for each privileged callback. `OWNER_TELEGRAM_ID` must remain a Cloudflare Secret.

## Telegram group status queue

The `.panel` and `.پنل` group commands refer to a Telegram group status message with inline controls, not a web dashboard. Requests are HMAC-signed by the Python Core and stored in the separate D1 `panel_requests` table. Delivery is bounded and owner/group/message scoped. The ten-minute Cron is only a lightweight Render liveness check; it does not activate Catch or drain arbitrary work.

## Session and review storage

- `kagecatch/session_manager.py`: Fernet encryption/decryption boundary.
- `kagecatch/sqlite_session_store.py`: local single-host encrypted-session fallback.
- `kagecatch/d1_session_store.py`: signed HTTPS transport for encrypted session ciphertext through the Worker into D1.
- `kagecatch/persistent_manual_review_queue.py`: durable manual-review state machine.
- `kagecatch/d1_manual_review_store.py`: signed Worker transport for review metadata.
- `migrations/`: D1 schemas. Do not apply a migration remotely without checking the live D1 migration ledger first.

The Python Core selects D1 session storage when `KAGECATCH_SESSION_STORE_URL` is configured. Keep `KAGECATCH_CORE_SECRET`, `KAGECATCH_FERNET_KEY`, Telegram API credentials, and bot tokens in their respective secret managers; never commit or paste them into chat.

## Development and tests

Python 3.11+ and Node.js 22 are required.

```bash
python -m pip install -e ".[api]"
python -m unittest discover -s tests -v
node --test worker/*.test.mjs
```

Run the Python Core with:

```bash
uvicorn kagecatch.core_api:app --host 0.0.0.0 --port 8000
```

Configure secrets through the host's secret manager. The Worker signs Core requests with timestamp, nonce, method, path, and body hash. The current in-memory Core replay guard is single-process; do not scale the Core horizontally until a shared nonce store is configured.

`docs/PRO_PANEL_AND_CORE_ROADMAP.md` is retained as a historical record; its web-panel/Mini-App proposal is superseded by the Telegram-only decision documented here.
