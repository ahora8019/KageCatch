# KageCatch Release Readiness — v1.0.0

**Purpose:** a fail-closed checklist for promoting the Control Worker and Python Core from development/preview to a production v1.0.0 deployment.

**Current status on `work/stages-5-9`: NOT READY.** This document is a gate, not a claim that any production resource has been provisioned or validated. Check each item with evidence from the exact release candidate.

## 1. Source and CI gate

- [ ] The release candidate is based on the current `main`; no unresolved merge conflicts or unexplained branch divergence remain.
- [ ] All Stage 5–9 changes are reviewed and merged through an approved pull request.
- [ ] Python test suite passes on the exact release commit.
- [ ] Worker test suite passes on the exact release commit.
- [ ] Migration tests pass and the complete migration sequence is reviewed for the target database.
- [ ] Dependency and secret scanning have no unresolved critical/high findings.
- [ ] Release commit SHA, test run URLs, and migration checksums are recorded.

**Fail closed:** a green run on an earlier commit does not validate a later commit. A missing CI result is not a pass.

## 2. Cloudflare Worker and D1 gate

- [ ] Production Worker name, account, route/custom domain, and environment are explicitly identified.
- [ ] Production D1 database is provisioned separately from `kagecatch-sessions-preview`; verify database ID and jurisdiction before any migration.
- [ ] `KAGECATCH_DB` points to the intended production D1 database.
- [ ] `CONNECT_LINKS` Durable Object binding and class migration are configured for the intended environment.
- [ ] All additive SQL migrations are applied in order and their resulting schema is verified.
- [ ] Production webhook URL and Telegram webhook secret/token are configured through the secret manager, never committed.
- [ ] Worker health, logs, alarm execution, and rollback procedure are verified in a non-production environment first.

**Do not copy the Preview D1 ID or Preview Durable Object binding into production configuration by assumption.**

## 3. Python Core and persistent hosting gate

- [ ] A persistent Python host is provisioned; the process does not sleep or scale to zero while Telegram sessions are expected to remain active.
- [ ] Durable encrypted storage is mounted and survives process restart and host replacement.
- [ ] Backup, restore, retention, and access-control procedures are tested.
- [ ] SQLite recognition queue is placed on persistent single-host storage, or replaced by a deliberately designed distributed queue before horizontal scaling.
- [ ] Core API is reachable only through the intended authenticated Worker-to-Core path.
- [ ] HMAC timestamp/nonce replay protection is shared and durable before running multiple Core instances.
- [ ] Health/readiness checks distinguish process liveness from dependency readiness.

## 4. Secrets and Telegram account safety gate

- [ ] Rotate any development credentials that may have appeared in logs, chat, screenshots, or test artifacts.
- [ ] Set `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `CORE_API_SECRET`, `KAGECATCH_CORE_SECRET`, Telegram API credentials, and Fernet encryption key only in approved secret stores.
- [ ] Confirm no secret value is present in Git history, build artifacts, logs, or client-side code.
- [ ] Verify Fernet key backup and recovery before storing real Telegram sessions.
- [ ] Confirm OTP and 2FA passwords are never logged or persisted as plaintext.
- [ ] Verify account connect, cancel, disconnect, revoke, and restart recovery in a controlled test account.
- [ ] Keep Catch and Broadcast disabled until the corresponding end-to-end safety tests are explicitly approved.

## 5. Controlled end-to-end verification

- [ ] Test account authorization using a designated test account; verify encrypted persistence and reconnect after Core restart.
- [ ] Test one authorized-session event through producer → durable queue → worker → review item, using non-sensitive test payloads.
- [ ] Test queue lease expiry, stale-worker fencing, retry limits, and dead-letter handling.
- [ ] Test panel request signature rejection, replay rejection, lease recovery, and stale completion fencing.
- [ ] Test Broadcast with a controlled test audience and explicit Owner confirmation.
- [ ] Test 429 pause, 401 operator pause, missing Safety Store fail-closed behavior, per-chat pacing, and circuit breaker.
- [ ] Simulate a crash before Broadcast preparation finishes; verify return to Owner confirmation without sending.
- [ ] Simulate an ambiguous in-flight send; verify it locks for Owner review and is not automatically retried.
- [ ] Verify audit records and operational alerts without recording OTPs, 2FA passwords, session strings, or message contents unnecessarily.

## 6. Release, rollback, and approval

- [ ] Publish a release note with exact commit SHA, supported features, known limitations, and migration list.
- [ ] Document rollback steps for Worker code and additive D1 schema; do not assume destructive schema rollback is safe.
- [ ] Confirm backups and a tested restore point before migration.
- [ ] Define an operator contact and incident response path for credential pauses, queue stalls, and uncertain Telegram delivery.
- [ ] Obtain explicit Owner approval for production migration, Worker deployment, Core deployment, and any live Telegram test. These are separate approvals.

## Known blockers — refreshed 2026-11-20

- `main` was last checked at `2a5366cbee1240fc459bd3dc7d921cbb30086ac8`. PR #46 remains Draft and GitHub reports it as not mergeable. File-level reconciliation has restored current mainline behavior in Core/Catch ingress, ReviewPipeline, bounded Catch receipt verification, and bounded Senpai media download; branch ancestry is still divergent and must be reconciled before merge/release.
- The last confirmed green CI run is on older commit `2d1aac2d88379df033d173d1bf422c213e2d4783`. The current head has no reported combined status checks or pull-request workflow run. Do not treat the older green run as validation of the current code.
- The queue/Catch integration now has regression tests for single detection, queue routing, invalid origin/media metadata, worker lease loss, review idempotency after an acknowledgement failure, and bounded worker shutdown. These tests have not yet run on the current head.
- The documented D1 resource is Preview; production database/bindings have not been established here.
- The Python Core still requires a verified persistent host and durable storage.
- Real-account authorization and live Catch/Broadcast end-to-end verification have not been performed.

Until these blockers are resolved with evidence, the correct release decision is **NO-GO**.
