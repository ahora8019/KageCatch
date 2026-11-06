# KageCatch Catch Engine and Session Runtime

## Supported targets

| Source ID | Target bot | Media | Command | Initial state |
|---|---|---|---|---|
| senpai_catcher | SenpaiCatcherBot | video | /pick | Frozen |
| henta_catcher | HentaCatcherBot | image | /catch | Configured |
| character_catcher | Character_Catcher_Bot | image | /catch | Configured |

Senpai remains registered but disabled because it is currently unavailable.

## Catch orchestration

1. A source adapter supplies a normalized spawn event and ranked candidates.
2. The engine rejects adapter/source mismatches and invalid candidates.
3. Candidates below the configured confidence threshold are sent to review.
4. A per-user quota gate is checked before sending.
5. A per-user/source/chat/message dedupe key prevents duplicate attempts.
6. The source adapter sends the command.
7. Only a confirmed target-bot response may produce a verified result.

Recognition is not implemented yet: the engine consumes candidate names and confidence scores from a future recognition component.

## Session security and runtime

SessionManager encrypts Telethon StringSession values with Fernet before handing them to a storage interface. The encryption key must come from a deployment secret manager and must never be committed or sent through Telegram.

SessionRuntime reconnects only previously stored sessions. It creates one isolated Telethon client per KageCatch user, checks is_user_authorized() before caching the client, rejects unauthorized sessions, and supports disconnect and revocation.

SQLiteSessionStore persists ciphertext (not raw StringSessions) in a local SQLite database. The database directory/file are restricted to owner permissions where the operating system supports chmod. This store is intended for a single execution host; it is not a shared multi-instance database.

## Authorizing an account

The transport-independent, bot-driven authorization state machine is in kagecatch/telegram_auth_flow.py. It supports one pending login per KageCatch user, a five-minute default expiry, a three-attempt limit, explicit cancellation, optional 2FA, and persistence only after Telegram confirms authorization. Phone codes and 2FA passwords are held only as method arguments during the request; they are not stored in the pending state or database.

The Control Worker issues a five-minute, one-time opaque link from the private bot chat. A Durable Object stores only the SHA-256 token hash, the Telegram sender ID, and the expiry; consumption is transactional and replay-resistant. The landing page only validates possession of the link. It does not authorize a Telegram account or create a Telethon session. No phone code or 2FA password is accepted by the bot or landing page. A separate user-controlled MTProto authorization handoff and authenticated Worker-to-Python execution API are still required.

For local development only, the explicit authorization helper and CLI remain available in kagecatch/telegram_authorization.py and scripts/authorize_telegram.py. The CLI collects verification material in a private terminal.

Never send API hashes, Fernet keys, or StringSessions to the bot, ChatGPT, GitHub issues, logs, or repository files. Do not commit data/kagecatch-sessions.sqlite3. The repository .gitignore excludes local database and secret files.

No real Telegram account has been authorized or tested. The bot-driven flow has unit-level test coverage only; it is not yet connected to the deployed Control Worker or a running Python host.

## Verification boundaries

- A sent command is not a successful catch.
- The response-verifier callback must be connected to a real target-bot response listener before any result can be trusted as verified.
- The SQLite store is single-host persistence, not a production multi-instance session service.
- Key rotation, access auditing, a managed production database, and deployment integration remain incomplete.
- No real Telegram account was connected and no catch command was sent during this development phase.

## Control bot interface\n\nThe menu exposes account connection, connected accounts, settings, statistics, security/session controls, disconnect, and help. Account connection creates a one-time link; link validation does not imply that the Python core or Telegram account authorization is operational. `/status` and `/help` remain shortcuts. `/admin` is disabled until an owner ID and explicit authorization policy are configured. Worker unit tests run with `node --test worker/index.test.mjs`.\n\n## Remaining integration work

- Design and review a secure local authorization handoff that does not transmit OTPs, 2FA passwords, or StringSessions through the bot chat.
- Add key rotation and session access/revocation auditing.
- Add persistent quotas and atomic deduplication.
- Add live Telegram response listeners and verifiers for each target bot.
- Add spawn ingestion and recognition (image/video frame extraction, catalog lookup, confidence calibration).
- Add an authenticated, retry-safe Worker-to-Python queue contract and a deployed execution process.


## Current implementation checkpoint

- `CatchEngine` is disabled by default. It returns `disabled` without sending any command until an explicit enable flag is supplied by the execution layer.
- `TelethonCatchAdapter` dispatches the configured `/catch {name}` command through an already-authorized user session. It rejects source/media mismatches and frozen targets.
- Dispatch and success verification are separate. Without a target-specific response verifier, the adapter always reports the receipt as unverified; a sent command is never presented as a successful catch.
- Target-specific response formats have not yet been validated against live bot replies. No catch command has been sent to a real target during this implementation.
- Spawn ingestion and visual recognition are still separate remaining work; the engine currently receives normalized candidate names and confidence values.
