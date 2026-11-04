# KageCatch Catch Engine

## Current scope

The first Python foundation implements deterministic catch orchestration without opening Telegram user sessions or sending real catch commands.

Flow:
1. A source adapter supplies a normalized spawn event and ranked candidates.
2. The engine rejects adapter/source mismatches and invalid candidates.
3. The highest-confidence candidate is selected.
4. Candidates below the configured confidence threshold are sent to review.
5. The quota gate is checked before any catch attempt.
6. A per-user/source/chat/message deduplication key prevents duplicate attempts.
7. The source adapter sends the catch command.
8. A verifier must confirm the target bot's response before the result is reported as verified.

## Supported targets

| Source ID | Target bot | Media | Command | Initial state |
|---|---|---|---|---|
| senpai_catcher | SenpaiCatcherBot | video | /pick | Frozen |
| henta_catcher | HentaCatcherBot | image | /catch | Configured |
| character_catcher | Character_Catcher_Bot | image | /catch | Configured |

Senpai remains registered but disabled because it is currently unavailable.

## Safety and correctness boundaries

- Catching is separate from recognition; the engine consumes candidates and confidence scores but does not claim to identify images/videos yet.
- A confidence threshold is mandatory and configurable.
- The in-memory deduplicator is development-only. Production must use an atomic persistent claim (for example a D1 uniqueness constraint or a transactional database in the Python execution environment).
- Quotas must be enforced by a persistent per-user policy before sending.
- A sent command is not a successful catch. Only the target bot's confirmed response can produce the verified result.
- Telegram user-session authorization, encrypted session storage, and the Telethon runtime are not part of this initial foundation.
- No production Worker deployment or real Telegram catch was performed.

## Next integration work

1. Implement persistent quota and dedupe storage.
2. Implement per-user authorized Telethon session management with encryption keys stored outside the repository.
3. Implement source-specific Telegram adapters and response verifiers.
4. Add spawn ingestion and recognition (image/video frame extraction, catalog lookup, and confidence calibration).
5. Connect the Python execution plane to the Worker through an authenticated, retry-safe queue contract.
