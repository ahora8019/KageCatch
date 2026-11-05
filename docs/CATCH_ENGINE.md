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

SessionRuntime reconnects only previously stored sessions. It creates one isolated Telethon client per KageCatch user, checks is_user_authorized() before caching the client, rejects unauthorized sessions, and supports disconnect and revocation. TelethonSessionClientFactory creates a client from an existing StringSession.

The runtime deliberately does not initiate login, request phone codes, or request 2FA passwords. Initial authorization/onboarding must be implemented as a separate, explicit and secure flow. Telegram API ID/hash and the Fernet key must be injected from deployment secrets, not hardcoded.

The current storage implementation used in tests is in-memory. Production needs persistent encrypted storage, key rotation, access controls, and revocation auditing. The runtime is not yet wired to the Cloudflare Worker or a deployed Python process.

## Verification boundaries

- A sent command is not a successful catch.
- The response-verifier callback must be connected to a real target-bot response listener before any result can be trusted as verified.
- In-memory deduplication and fake storage are development/test components, not production persistence.
- No real Telegram account was connected and no catch command was sent during this development phase.

## Remaining integration work

- Persistent encrypted session storage and key rotation.
- Explicit user authorization/onboarding flow with secure secret handling.
- Persistent quotas and atomic deduplication.
- Live Telegram response listeners and verifiers for each target bot.
- Spawn ingestion and recognition (image/video frame extraction, catalog lookup, confidence calibration).
- Authenticated, retry-safe Worker-to-Python queue contract and a deployed execution process.
