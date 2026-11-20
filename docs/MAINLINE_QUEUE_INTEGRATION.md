# Mainline Integration — Queue, CatchPipeline, and Core

**Purpose:** record the implemented queue/Catch boundary and the remaining merge/validation gates. This document does not authorize deployment or live Telegram operations.

## Required architecture

- Core routes each incoming Telegram event through exactly one pipeline.
- `CatchPipeline` remains the sole owner of detection and Catch safety decisions.
- Immediate Catch remains behind the mainline checks: trusted character identity, metadata/target match, explicit per-user opt-in, enabled engine with atomic admission, valid origin, matching adapter, and receipt verification.
- If immediate Catch is not eligible, CatchPipeline passes the same already-detected Spawn to the recognition queue. It does not re-run detection.
- The queue stores bounded recognition metadata and origin identifiers only. It never stores Telethon event objects, media bytes, message text, session strings, OTPs, or 2FA passwords.
- RecognitionWorker resolves candidate suggestions and creates a durable human-review item. It never auto-selects a character or sends a Catch command.
- Queue failures fail closed. They do not trigger an inline resolver retry or bypass Catch safety checks.

## Implemented changes on `work/stages-5-9`

### Core and ingress

- `core_api.py` was rebuilt from the latest checked mainline version (`2a5366cbee1240fc459bd3dc7d921cbb30086ac8`) and then given the queue lifecycle additions. The guarded `catch_pipeline or review_pipeline` routing is preserved.
- The raw-event RecognitionJobProducer is not installed as the incoming-event handler.
- Core constructs the producer/worker only when queue, review queue, detector, and resolver dependencies are all available.
- CatchPipeline receives the producer only after queue initialization; the producer is called only from CatchPipeline's manual-review branch.
- Core shutdown signals the worker, allows up to ten seconds for an active job to drain, cancels only after the deadline, then closes the queue and review-store resources.

### Recognition and review

- CatchPipeline detects once and passes the already-detected Spawn, validated chat ID, and allowlisted media kind to `process_spawn`.
- Malformed event media kinds are normalized to `unknown`; the producer independently rejects malformed media values.
- The worker validates queued origin metadata and dead-letters invalid payloads, including non-string media kinds, zero chat IDs, and non-positive message IDs.
- Queue leases are renewed while long work is running. A renewal failure cancels processing and prevents acknowledgement.
- Review persistence uses a deterministic ID derived from the recognition job ID. If D1 commits the review but queue acknowledgement fails, retrying the job reuses the same review ID; conflicting reuse is rejected.
- The latest mainline `ReviewPipeline.process_spawn` fallback has been restored, so CatchPipeline's non-queue fallback remains valid.

### Mainline security and media changes restored

- `TelethonCatchAdapter` uses a bounded 256-entry sent-message cache and verifies the exact receipt/target context. Verifier exceptions and non-literal-true results fail closed.
- `TelethonFrameExtractor` uses bounded streaming downloads (64 KiB chunks), enforces the 25 MiB default media limit while streaming, and applies a download timeout. The previous unbounded `download_media(..., file=bytes)` path is not retained.
- The corresponding mainline regression tests were restored on the branch.

## Regression coverage added or preserved

- Queue configuration never replaces the guarded CatchPipeline incoming handler.
- CatchPipeline calls the detector once and enqueues the same detected Spawn for manual review.
- Queue failure does not fall back to synchronous review.
- Invalid chat origin fails closed.
- Malformed media kind is normalized/rejected safely.
- Worker dead-letters malformed origin metadata rather than retrying it forever.
- Worker lease loss cancels processing without acknowledgement.
- Review write remains idempotent if acknowledgement fails after persistence.
- Core shutdown drains active work within a bounded grace period and cancels only after the deadline.
- Mainline Catch precedence, strict receipt verification, bounded cache, and bounded media download tests are retained.

## Validation and merge status

- Latest confirmed green CI run is on older commit `2d1aac2d88379df033d173d1bf422c213e2d4783`; it does **not** validate the current branch head.
- The current branch head has no reported GitHub check runs or combined commit statuses.
- The PR remains Draft and GitHub reports it as not mergeable. Branch history is still divergent from main; use the live PR comparison for exact ahead/behind counts.
- File-level reconciliation has restored the latest mainline behavior in the files listed above; it has **not** rebased the branch history or established merge readiness.
- Python and Worker test suites have not been executed against the current head in this environment.

## Remaining gates

1. Reconcile the remaining branch history against main without wholesale replacement of either side.
2. Obtain fresh Python and Worker CI results on the exact final head.
3. Review the SQLite queue's single-host/persistent-disk assumption before any production use.
4. Run controlled end-to-end tests only after explicit approval and in a non-production Telegram environment.
5. Keep production deployment, migrations, and live Telegram sends disabled until separately approved.
