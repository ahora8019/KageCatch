# KageCatch Architecture Baseline

Status: source-level audit, 2026-11-18  
Scope: development architecture only. This document does not authorize deployment, remote migrations, credential changes, or live Telegram activity.

## 1. System objective

KageCatch is a Telegram-first, multi-user spawn-recognition and catch-orchestration system. Telegram is the control interface; Python/Telethon is the execution environment. Cloudflare Worker provides the bot-facing control plane and D1-backed shared coordination. The design must fail closed when shared safety state, authentication, or durable coordination is unavailable.

## 2. Current component map

| Plane | Component | Responsibility | Current evidence / limitation |
|---|---|---|---|
| Control | Telegram Bot API + Cloudflare Worker | Webhook, role checks, inline menus, callbacks, status and owner controls | Worker source and mock tests exist. No current deployment is implied. |
| Control persistence | Cloudflare D1 (`KAGECATCH_DB`) | Encrypted session blobs, panel requests, quotas and shared state | Preview binding is declared in `wrangler.toml`; migrations are not all applied remotely. |
| One-time coordination | Durable Object `CONNECT_LINKS` | One-time connect-link and nonce claims | Binding exists in Wrangler config; Worker code uses it for replay protection. |
| Execution API | Python FastAPI (`kagecatch/core_api.py`) | Authenticated account/runtime API and internal service boundary | HMAC request verification exists. Its in-memory nonce store is single-process only. |
| Session lifecycle | `SessionManager`, `SessionRuntime` | Fernet encryption, per-user Telethon clients, authorization checks, disconnect/revocation | Local runtime foundation exists. Distributed startup is deliberately blocked. |
| Local persistence | SQLite session/safety stores | Single-host encrypted session and safety metadata | WAL and restrictive file permissions; not a multi-host coordinator. |
| Event ingestion | Telethon handlers + target adapters + `SpawnDetector` | Normalize trusted message context and media type | Metadata normalization exists; it does not perform visual recognition or download media. |
| Background processing | Functional Core queue + recognition worker | Durable local jobs, leases/retries, review routing | SQLite-backed implementation exists; cross-host shared queue is not established. |
| Recognition | Recognition provider interface | Return ranked candidates with confidence | Provider boundary exists; a production vision model/catalog pipeline is not implemented. |
| Review | Manual Review | Human decision for uncertain candidates | Review workflow and persistence foundations exist; execution approval remains gated. |
| Catch | `CatchEngine` + target adapters | Quota, dedupe, command dispatch and result verification | Engine is disabled by default. Target-specific live response verification is not proven. |
| Safety | Telegram Safety Guard + D1 Safety primitives | Session/security locks, FloodWait, retry deadlines and send pacing | Local synchronous guard exists. PR #37 adds Worker-side D1 primitives; the Core bridge and complete outbound integration are still missing. |
| Observability | Monitoring events / Worker health | Health and operational diagnostics | Basic events/health exist; end-to-end operational telemetry is incomplete. |

## 3. Intended request and event flows

### 3.1 Control-plane interaction

1. Telegram delivers an update to the Worker webhook.
2. Worker validates the update and resolves the user role from server-side state.
3. Worker renders or edits the existing Telegram message with inline keyboard controls.
4. Any privileged callback is authorized again at action time.
5. The Worker reports Core state only from an authenticated Core response; missing configuration is not reported as connected.

### 3.2 Session lifecycle

1. The user starts a one-time account-connection flow from the control bot.
2. The authorization handoff must remain separate from bot chat; OTP, 2FA passwords, API hashes, and raw session strings must not be sent through chat.
3. Python Core creates/validates the Telethon session and checks Telegram authorization.
4. SessionManager encrypts the StringSession before persistence.
5. D1 stores ciphertext through the signed Worker API; the Worker verifies timestamp, nonce, method, path and body hash.
6. SessionRuntime owns one client per KageCatch user and must hold a distributed lease before a multi-instance client can start.

### 3.3 Spawn and recognition

1. Telethon receives a message from a configured target/source.
2. A target adapter validates the source and extracts trusted message context.
3. SpawnDetector normalizes message ID, chat ID, timestamp and media kind.
4. A durable job is enqueued with an idempotency key and trusted origin context.
5. Recognition extracts usable media/features, searches a trusted catalog and returns ranked candidates with calibrated confidence.
6. Low-confidence or ambiguous candidates go to Manual Review. Untrusted text in a Telegram message must never be treated as a verified character identity.

### 3.4 Catch execution

1. CatchEngine checks its explicit enabled state, source/media compatibility, candidate validity and confidence threshold.
2. A persistent per-user quota and atomic dedupe claim are acquired.
3. Immediately before every outbound Telegram action, an asynchronous shared Safety Gate reserves the send slot and checks session revocation, security/manual locks, FloodWait and Bot API retry deadlines.
4. Only after the gate allows the action may a target adapter dispatch the configured command.
5. A target-specific response listener correlates the reply with the originating request.
6. A Catch is marked successful only after the destination bot's response verifier confirms it. A successful send alone is not a successful Catch.

## 4. Trust and failure boundaries

- Telegram update payloads, callback data, message text, media metadata and recognition output are untrusted until validated.
- User IDs and roles are derived from authenticated server-side identity, never accepted as authority from a client payload.
- Worker-to-Core and Core-to-Worker requests use HMAC-SHA256 over timestamp, nonce, method, exact path and SHA-256 body digest.
- Nonces must be claimed in a shared replay store before side effects. The current Python in-memory nonce implementation is not sufficient for horizontal Core scaling.
- Missing or unavailable shared safety state must deny outbound actions; it must never silently fall back to process-local pacing in distributed mode.
- Local SQLite queue/session/safety stores are single-host facilities. They do not establish multi-instance correctness.
- Session revocation must invalidate both the session record and shared safety state before any subsequent send can be allowed.
- Never log message bodies, media, OTPs, 2FA passwords, API hashes, Fernet keys, bot tokens or session strings.
- No live Telegram call, remote D1 migration, webhook mutation, secret change or deployment is part of this development baseline.

## 5. Verified gaps and blockers

1. **D1 Safety API is not implemented yet.** PR #37 currently adds D1 Worker-side reservation, backoff and lock primitives, but Python Core cannot call them through a dedicated authenticated contract yet.
2. **Safety Gate is not end-to-end.** The Python guard has a synchronous state-store interface; the D1 operations are asynchronous. The integration must not block the event loop or bypass the shared atomic reservation.
3. **Outbound coverage is incomplete.** Every Telethon send path—including Catch adapters and any control/notification sends—must be audited and guarded immediately before network I/O.
4. **Safety-state lifecycle is incomplete.** Session creation, revocation, owner lock/unlock and FloodWait updates must maintain the shared D1 row consistently. A missing owner row must remain fail-closed.
5. **Distributed runtime remains blocked.** The configured Core startup explicitly refuses D1 mode until shared safety state is available. D1 session storage alone is not sufficient.
6. **Queue coordination is local.** The SQLite WAL queue is useful for one host; a shared durable queue/claim contract is still required before multiple execution replicas.
7. **Recognition is not production-ready.** Spawn normalization exists, but media retrieval/frame extraction, catalog search, a real vision provider and confidence calibration remain unfinished.
8. **Catch verification is incomplete.** Target-specific response listeners, correlation and verified receipts need implementation and tests. Catch remains disabled.
9. **Documentation has drift.** Some older design notes describe a Mini App as the primary dashboard or describe connection paths as pending. The current product target is Telegram-native inline navigation; the legacy `/panel` route is retained until separately reviewed and explicitly retired.

## 6. Ordered implementation plan

### Phase 0 — Baseline (this document)
- Record actual components, trust boundaries, evidence and gaps.
- Keep all production and live-account actions disabled.

### Phase 1 — Shared D1 Safety API
- Reuse the established Worker HMAC canonicalization and Durable Object nonce-claim pattern.
- Add narrow endpoints for outbound reservation, FloodWait/Bot retry updates, and owner safety lock state.
- Bind owner identity to authenticated Core requests; validate numeric Telegram owner IDs and known session ownership.
- Add Worker tests for missing/invalid signature, expired timestamp, nonce replay, malformed payload, unknown owner, lock/revocation and D1 failure.
- Keep migration 0009 source-only.

### Phase 2 — Python async D1 safety adapter
- Add a typed async client using the existing signed-request contract.
- Test canonical signing against the Worker implementation, HTTP failures, timeouts, replay-safe retry behavior and malformed responses.
- Introduce an async outbound gate at the adapter boundary; do not call synchronous SQLite APIs as a substitute in distributed mode.

### Phase 3 — Close every outbound path
- Inventory every Telethon send call.
- Require a Safety Gate reservation immediately before each send.
- Persist FloodWait and other retry deadlines after recognized platform responses.
- Add regression tests proving no adapter can send when the gate denies or is unavailable.

### Phase 4 — Distributed session lifecycle
- Initialize shared safety rows when sessions become authorized.
- Set `session_revoked` before/with revocation and ensure stale leases cannot send.
- Connect the existing distributed lease client only after the shared safety adapter is operational.
- Keep local SQLite explicitly single-instance.

### Phase 5 — Shared queue and idempotent processing
- Define shared job schema, atomic claim/lease, fencing, retry and dead-letter semantics.
- Preserve trusted spawn origin and idempotency across retries.
- Prove duplicate and multi-worker behavior with stateful integration fakes before considering remote infrastructure.

### Phase 6 — Recognition and review
- Implement media acquisition and bounded image/video preprocessing.
- Add a real provider adapter and reference catalog.
- Calibrate confidence and route uncertain candidates to review; never auto-select from untrusted hints.

### Phase 7 — Verified Catch adapters
- Add target-specific response listeners and correlation IDs.
- Keep Catch disabled until quota, dedupe, safety, adapter and verification tests pass.
- Start with local fixtures and dry-run only; live Catch requires a separate explicit approval.

### Phase 8 — Operational readiness
- Add health/readiness checks, structured redacted logs, metrics, alert conditions and recovery runbooks.
- Review cost and hosting constraints before any paid service.
- Deployment, remote migrations, credential changes and live Telegram tests require separate explicit approval.

## 7. Completion criteria

A phase is complete only when its source changes are reviewed, tests cover the behavior and failure paths, CI passes on the exact head commit, and the remaining limitations are documented. Mock tests do not prove live Cloudflare D1, Telegram or multi-host behavior. Production readiness must never be inferred from CI alone.
