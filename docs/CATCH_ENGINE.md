> **Current implementation note (2026-11-20):** The web dashboard, Mini App, browser login page, one-time login links, and `TelegramQrAuthorizationFlow` have been retired. The active account flow is phone number → inline OTP keypad → optional 2FA, entirely in the private Telegram bot conversation. See the repository README for the current control and deployment boundaries.

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
4. An atomic per-user/source rolling quota and deduplication reservation is acquired.
5. The source adapter sends the command only after admission succeeds.
6. Only a valid receipt and a confirmed target-bot response may produce a verified result.

The engine consumes normalized candidate names and confidence scores. Anime-scene similarity is never treated as character confidence.

## Catch admission and duplicate protection

`kagecatch/catch_admission.py` provides `SQLiteCatchAdmissionStore`. It performs the dedupe check, rolling quota count, and reservation insert in one SQLite `BEGIN IMMEDIATE` transaction. Concurrent Core workers using the same durable SQLite file therefore cannot both reserve the same spawn.

The quota is explicitly configured by the execution layer; no arbitrary production limit is hard-coded:

```python
admission = SQLiteCatchAdmissionStore(
    "/var/lib/kagecatch/catch-admission.sqlite3",
    max_attempts=OPERATOR_CONFIGURED_LIMIT,
    window_seconds=OPERATOR_CONFIGURED_WINDOW_SECONDS,
)
engine = CatchEngine(
    confidence_threshold=OPERATOR_CONFIGURED_CONFIDENCE,
    admission=admission,
    enabled=False,
)
```

The database is intended for one persistent Python host with a durable local volume, not multiple hosts sharing an ephemeral filesystem. It stores admission metadata only (user, source, dedupe key, attempt timestamp), never Telegram session material. The dedupe key is retained indefinitely, even after the rolling quota window expires, so replaying an old update cannot become a fresh catch. This table grows over time; define and review a privacy/retention/archive policy before high-volume production use.

Every admitted attempt consumes a quota slot, including a send that later times out or has an ambiguous outcome. The engine deliberately does not release the reservation or automatically retry: Telegram may already have accepted the first command. Such cases require manual investigation before any new attempt.

An enabled `CatchEngine` requires an atomic `admission` implementation. The older split `QuotaGate` + `Deduplicator` arguments remain only for disabled/test compatibility and cannot activate dispatch. Missing or failing admission returns `admission_unavailable` without sending. Candidate lists are bounded to 30 entries; malformed spawn identities and receipts are rejected.

## CatchPipeline — Core ingress integration

`kagecatch/catch_pipeline.py` provides the guarded bridge from the existing per-account incoming listener to `CatchEngine`. It can be passed as `catch_pipeline=` to `create_app`; when present, Core routes incoming events through it before the legacy ReviewPipeline handler. Without it, the existing manual-review-only behavior is unchanged.

Dispatch requires every gate below:
- The engine is explicitly enabled and has an atomic admission store.
- The current KageCatch user has explicitly enabled Catch (the injected `catch_is_enabled(user_id)` callback must return the boolean `True`).
- The target detector supplied an explicit `character_name` and a finite `character_confidence` in the 0..1 range.
- The target-specific adapter factory returns an adapter matching the spawn source and media kind.
- The event has a valid chat ID; the CatchEngine revalidates the normalized Spawn and receipt.

Anime title similarity, anime-level confidence, and title-to-cast mappings are never substituted for character confidence. If an individual character is not identified, confidence is below threshold, the user has not opted in, the engine is disabled, or a suitable adapter cannot be created, the same detected Spawn is passed directly to `ReviewPipeline.process_spawn` for human review. The detector is not run a second time.

Ambiguous send failures are returned as `send_failed`; the pipeline does not automatically requeue or resend them. CatchEngine retains the atomic admission reservation because the target may already have received the command.

### Current recognition boundary

This integration is deliberately fail-closed, not a claim that character recognition is complete:
- The built-in Senpai video adapter currently uses trace.moe for anime/episode scene matching. It leaves `character_name=None` and `character_confidence=0`; scene similarity is not character identity. Senpai is also frozen/disabled in the target registry.
- The built-in image targets do not yet have target-specific character recognition adapters wired into SpawnDetector.
- `anime_character_map.json` is currently empty, and even a populated anime-to-cast mapping is suitable only for suggestions, not frame-level character identity.
- A target-specific response verifier/listener is still required before a sent command can be reported as verified.

As a result, current built-in Spawn events continue to fall back to manual review. No live Catch is enabled by this Core ingress change.

## Session security and runtime

SessionManager encrypts Telethon StringSession values with Fernet before handing them to a storage interface. The encryption key must come from a deployment secret manager and must never be committed or sent through Telegram.

SessionRuntime reconnects only previously stored sessions. It creates one isolated Telethon client per KageCatch user, checks is_user_authorized() before caching the client, rejects unauthorized sessions, and supports disconnect and revocation.

SQLiteSessionStore persists ciphertext (not raw StringSessions) in a local SQLite database. The database directory/file are restricted to owner permissions where the operating system supports chmod. This store is intended for a single execution host; it is not a shared multi-instance database.

## Authorizing an account

The transport-independent, bot-driven authorization state machine is in kagecatch/telegram_auth_flow.py. It supports one pending login per KageCatch user, a five-minute default expiry, a three-attempt limit, explicit cancellation, optional 2FA, and persistence only after Telegram confirms authorization. Phone codes and 2FA passwords are held only as method arguments during the request; they are not stored in the pending state or database.

The active account-connection path is Telegram-native Phone Login:
- The user starts account connection in the private Control Bot and enters an E.164 phone number.
- The bot displays an inline numeric keypad for the OTP. Callback data carries only one-digit actions; it never contains the complete code.
- If Telegram requires 2FA, the user enters the password in the private bot conversation. The Worker forwards the values to the Python Core over timestamped HMAC-authenticated requests with nonce/replay protection and bounded request bodies.
- Short-lived authorization state is encrypted and bound to the Telegram user ID. The Core does not write OTP/2FA values to logs or pending-session storage; the final Telethon StringSession is encrypted before persistence.
- The bot attempts to delete the user's phone/code/password messages, but deletion is best-effort. Telegram bot chats are not end-to-end encrypted, so credentials transit the bot backend.
- Browser login pages, one-time login links, browser sessions, and the separate `TelegramQrAuthorizationFlow` implementation are not part of the active system and have been removed.
- The local authorization CLI remains a separate local-development tool. It is not the deployed account-connection transport.
No real Telegram account has been authorized or validated in this development phase. The path has unit-level coverage only; controlled real-account validation and operational review remain prerequisites before enabling real-account use.

For local development only, the explicit authorization helper and CLI remain available in kagecatch/telegram_authorization.py and scripts/authorize_telegram.py. The CLI collects verification material in a private terminal.

Never send API hashes, Fernet keys, or StringSessions to the bot, ChatGPT, GitHub issues, logs, or repository files. Do not commit data/kagecatch-sessions.sqlite3. The repository .gitignore excludes local database and secret files.

No real Telegram account has been authorized or tested. The Telegram-native flow has unit-level coverage; production end-to-end account authorization has not been validated.

## Verification boundaries

- A sent command is not a successful catch.
- The response-verifier callback must be connected to a real target-bot response listener before any result can be trusted as verified.
- The SQLite store is single-host persistence, not a production multi-instance session service.
- Key rotation, access auditing, a managed production database, and deployment integration remain incomplete.
- No real Telegram account was connected and no catch command was sent during this development phase.

## Control bot interface

The private Telegram bot is the only control surface. Members use inline menus for account connection, Catch status, bot targets, settings, statistics, and security/session controls. Owners additionally receive member administration, invitations, broadcast draft/preview/confirmation, and Telegram send-safety monitoring/recovery. `/start`, `/panel`, `/status`, and `/help` are bot commands; `/panel` does not serve a web page. The web dashboard, Mini App, browser login links, browser sessions, and browser account APIs have been removed.

## Recognition job queue

`kagecatch/job_queue.py` implements a local SQLite queue with typed jobs, idempotency, priority, delayed scheduling, bounded retry/dead-letter behavior, fenced leases, heartbeat renewal, and expired-lease recovery. The `RecognitionWorker` claims only `spawn.recognize` jobs and persists resolved candidates into the durable manual-review queue. It never dispatches Catch commands. Jobs are created only after a Spawn has already been detected and routed to manual review; raw Telegram ingress is not bound directly to the queue producer.

The queue is opt-in through `KAGECATCH_JOB_QUEUE_PATH` and requires persistent single-host storage. It is not a distributed queue and must remain disabled on an ephemeral filesystem. D1 manual-review creation uses deterministic IDs and idempotent insert handling to survive a lost queue acknowledgement without creating duplicate review items.

## Remaining integration work

- Complete a controlled real-account security review of the Telegram-native OTP/optional-2FA flow before production account authorization.
- Rotate the previously exposed Core shared secret through the secret managers, then verify the Worker-to-Core HMAC path without exposing the value in chat or logs.
- Configure a durable host path (or replace the local SQLite queue with a D1-backed queue) before activating the background recognition worker in production.
- Complete image/video recognition coverage and calibrated character-level confidence; anime-scene similarity alone is not character identity.
- Approve exact Catch command syntax for each target and complete controlled target-response verification before enabling any target. All production Catch targets are currently disabled.
- Complete key rotation and session access/revocation auditing.

## Current implementation checkpoint

- `CatchEngine` is disabled by default and requires an atomic admission gate if explicitly enabled.
- Every `TARGETS` entry is currently disabled. Adapter mechanics are tested with test-only opt-in; production command construction fails closed.
- Atomic admission and rolling per-user/source quotas are implemented in `kagecatch/catch_admission.py`. An admitted reservation remains consumed after ambiguous send errors, preventing automatic duplicate retries.
- Dispatch and success verification are separate. Without a target-specific response verifier, a sent command is never presented as a successful Catch.
- SenpaiCatcher inbound Spawn recognition is wired to manual review. Only the extracted frame from a qualifying Spawn video is sent to trace.moe; the full video is not uploaded.
- No real Telegram account was connected and no Catch command was sent to a real target during this implementation.
