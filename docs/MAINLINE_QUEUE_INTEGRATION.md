# Mainline Integration Notes — Queue and CatchPipeline

**Status:** design constraint for reconciling `work/stages-5-9` with `main`; no runtime behavior is changed by this document.

## Verified architectural difference

The current `main` branch contains `kagecatch/catch_pipeline.py` and its guarded Core ingress integration. The pipeline:

- Detects a spawn once.
- Validates that character identity metadata belongs to the detected target.
- Requires explicit Catch enablement, an enabled engine with atomic admission, valid chat identity, and a matching target adapter before dispatch.
- Sends the same already-detected Spawn to `ReviewPipeline.process_spawn` when any dispatch gate fails.
- Keeps ambiguous Catch sends out of automatic retry.

The `work/stages-5-9` branch instead adds `SQLiteJobQueue`, `RecognitionJobProducer`, and `RecognitionWorker`. Its producer runs its own detector and its worker resolves candidates and creates a durable human-review record. It does not call CatchEngine.

The two ingress implementations are therefore not interchangeable. Replacing main's incoming `CatchPipeline` handler with the branch's `RecognitionJobProducer` would bypass guarded Catch dispatch. Running both independently on the same raw event would run detection twice and could create duplicate review work.

## Required integration boundary

Preserve `CatchPipeline` as the single owner of incoming-event detection and Catch safety decisions.

The safe future queue integration point is after the single detector result exists:

1. `CatchPipeline` calls its detector exactly once.
2. If the spawn is eligible for immediate Catch, retain the existing explicit opt-in, source/metadata match, confidence, adapter, atomic admission, and receipt-verification gates unchanged.
3. If the spawn must go to human review, pass that already-detected Spawn to a queue producer (rather than passing the raw Telegram event and detecting again).
4. The queued payload contains only bounded, validated metadata and origin identifiers. Do not serialize Telethon event objects, media bytes, session strings, OTPs, or message contents.
5. A lease-fenced worker resolves candidates and persists a review item with a deterministic idempotency key derived from the job ID.
6. If queue creation or processing is unavailable, do not fall back to unbounded inline retries or automatic Catch dispatch. Return a clear review-persistence failure and preserve the existing fail-closed behavior.
7. Keep the Worker/D1 panel request queue and the Durable Object connection-link/broadcast alarm queue separate from this Python recognition queue; they have different ownership and delivery guarantees.

## Required tests before porting the queue into main

- Incoming event detection is called exactly once for both Catch and review paths.
- A trusted, opted-in, high-confidence spawn still reaches CatchEngine and verifies its receipt; queue availability must not change this path.
- Low confidence, source mismatch, disabled engine, missing opt-in, invalid chat, and adapter failure never dispatch Catch and route the same detected Spawn to review.
- Review enqueue is idempotent across job retries and process restarts.
- Lease expiry and heartbeat loss fence stale workers; a stale worker cannot complete or create a second review record.
- Queue unavailable / invalid payload remains fail-closed and never triggers a Catch command.
- Ambiguous Catch send remains reserved and is never automatically re-enqueued.
- Shutdown cancels the worker and closes queue resources without losing durable jobs.

## Reconciliation rule

Do not merge the two branches wholesale and do not replace main's `core_api.py` with the older branch copy. Port the queue implementation and tests as isolated components first, then adapt the single mainline CatchPipeline-to-review boundary with explicit tests. Reconcile the Worker changes separately after preserving the latest mainline Catch ingress and security changes.

## Current verified state (2026-11-20)

- `main` includes `kagecatch/catch_pipeline.py` and `tests/test_catch_pipeline.py`; the feature branch does not.
- The feature branch includes `job_queue.py`, `recognition_job_producer.py`, `recognition_worker.py`, and their dedicated tests; main does not.
- Main's Core runtime selects `catch_pipeline` before `review_pipeline` for incoming events.
- The branch's Core startup installs the recognition producer as the incoming handler when the queue runtime is available.
- Therefore a safe integration needs an adapter at the already-detected Spawn/review boundary, not a wholesale Core API cherry-pick.

This document is a design/reconciliation note only. It does not assert that the queue has been integrated into current main, that CI has passed, or that production behavior has been validated.
