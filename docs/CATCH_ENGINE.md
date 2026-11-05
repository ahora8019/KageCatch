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

The explicit authorization helper is in kagecatch/telegram_authorization.py. The local CLI is scripts/authorize_telegram.py.

1. Install the project with the Telegram extra: python -m pip install '.[telegram]'.
2. Configure KAGECATCH_API_ID, KAGECATCH_API_HASH, KAGECATCH_FERNET_KEY, and KAGECATCH_USER_ID as environment secrets.
3. Run python scripts/authorize_telegram.py from a private terminal.
4. Enter the phone number, Telegram login code, and (only if requested) 2FA password in that terminal. The code/password are hidden where getpass is used.
5. The script persists a session only after Telegram confirms the account is authorized. It disconnects the client afterward.

Never send login codes, 2FA passwords, API hashes, Fernet keys, or StringSessions to the KageCatch control bot, ChatGPT, GitHub issues, logs, or repository files. Do not commit the generated data/kagecatch-sessions.sqlite3 database. The repository .gitignore excludes local database and secret files.

The CLI has not yet been run against a real account. A real-account test requires the owner to run it in a private environment and enter Telegram's verification material locally; those credentials must not be shared in this chat.

## Verification boundaries

- A sent command is not a successful catch.
- The response-verifier callback must be connected to a real target-bot response listener before any result can be trusted as verified.
- The SQLite store is single-host persistence, not a production multi-instance session service.
- Key rotation, access auditing, a managed production database, and deployment integration remain incomplete.
- No real Telegram account was connected and no catch command was sent during this development phase.

## Remaining integration work

- Validate the local authorization CLI against an owner-controlled Telegram account.
- Add key rotation and session access/revocation auditing.
- Add persistent quotas and atomic deduplication.
- Add live Telegram response listeners and verifiers for each target bot.
- Add spawn ingestion and recognition (image/video frame extraction, catalog lookup, confidence calibration).
- Add an authenticated, retry-safe Worker-to-Python queue contract and a deployed execution process.
