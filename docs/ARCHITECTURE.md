# KageCatch Architecture Baseline

**Snapshot date:** 2026-11-21  
**Purpose:** Establish one operational source of truth before adding another Worker or enabling Catch.

This document records verified repository and infrastructure state. It is not a claim that KageCatch is production-ready.

## 1. Executive status

KageCatch is a Telegram-first control plane plus a Python execution plane. The project currently has one live Cloudflare control Worker and one Render Core service. Both are operating in a Preview-oriented configuration; there is no separately provisioned Render Production service or KageCatch Production D1 database.

The immediate priority is stabilization and separation of responsibilities, not adding another public Worker.

| Area | Verified state | Operational status |
|---|---|---|
| Telegram control bot | `@KageCatchTst2Bot`, webhook configured | Degraded: Telegram has reported webhook HTTP 503 and pending updates |
| Cloudflare Worker | `kagecatch-control`, one active deployment at 100% | Responds to health checks; webhook path has reported 503 |
| Durable Objects | One SQLite namespace: `ConnectionLinkStore` | Global singleton is a contention/quota risk |
| D1 | `kagecatch-sessions-preview`, 10 migrations applied | Health endpoint reports storage ready |
| Python Core | Render `kagecatch-core-preview`, Free plan | `/healthz` reports alive; not a Production service |
| Recognition queue | D1-backed queue integration is optional/configuration-driven | Recent queue failures need post-quota-reset verification |
| Catch execution | Disabled by default | Must remain disabled |
| Production isolation | No separate Core Production service or D1 Production database found | Not ready |

## 2. Intended system boundaries

### Control plane — Cloudflare

Responsibilities:
- Receive Telegram Bot API webhook updates.
- Authenticate and authorize bot users and Owner actions.
- Apply Telegram send pacing and circuit-breaker controls.
- Persist user/control-plane state and durable job metadata.
- Forward authenticated, bounded requests to Python Core.
- Run the ten-minute Render liveness check.

The Worker must not perform long-running Telethon work or infer that a queued job has completed merely because it accepted a request.

### Execution plane — Python Core on Render

Responsibilities:
- Own Telethon account sessions and session lifecycle.
- Receive signed requests from the Worker.
- Detect Spawn events and produce recognition jobs.
- Resolve candidate characters conservatively.
- Create and manage manual-review records.
- Execute Catch only after every explicit safety gate is satisfied.

Render Free has ephemeral local storage. SQLite-backed session, queue, or admission stores must not be treated as durable on this service.

### Data plane — D1 and Durable Objects

Current data responsibilities are split across:
- D1: Telegram sessions, authorization challenges, manual review, panel requests, Telegram safety/pacing, durable recognition jobs, and Catch admission.
- One global Durable Object instance: connection/user registry, invitations, activity, broadcast drafts, temporary auth state, and Core request replay nonces.

The global Durable Object is the most important architectural hotspot. It is selected with the fixed name `connection-links-v1`, so requests across users converge on one object. Its responsibilities are too broad for a single coordination actor.

## 3. Verified deployment inventory

### Cloudflare

- Account used for the project: `ahora.project@proton.me`.
- Worker: `kagecatch-control`.
- Worker URL: `https://kagecatch-control.ahora-project.workers.dev`.
- Active Worker deployment: 100% traffic on the latest deployment observed during this audit.
- Cron: `*/10 * * * *`.
- D1 binding: `KAGECATCH_DB`.
- D1 database: `kagecatch-sessions-preview`.
- D1 database ID: `ef313232-4bfb-43df-915d-b7b22b076fa2`.
- Durable Object namespace: `kagecatch-control_ConnectionLinkStore`.
- Durable Object class: `ConnectionLinkStore`.

The checked-in `wrangler.toml` binds the Worker named `kagecatch-control` to the Preview D1 database. Do not use it as a Production deployment configuration.

The checked-in `wrangler.preview.toml` is for local Worker execution with the Preview D1 binding. It is not a Production configuration.

### Render

- Service: `kagecatch-core-preview`.
- URL: `https://kagecatch-core-preview.onrender.com`.
- Plan: Free.
- Repository: `ahora8019/KageCatch`, branch `main`.
- Latest deployment observed: Live on commit `7c95094082446d66ce87b6dc2d335db533b9f3f2`.

The deployment for PR #91 was superseded by a subsequent deployment from the updated main branch. The current service health endpoint returned `{"service":"KageCatch Core","status":"alive"}`.

### Live Worker health snapshot

The Worker health endpoint reported:
- `webhook_ready` and webhook configured.
- Python Core connected.
- D1 storage ready.
- 10 D1 migrations, latest `0010_d1_catch_admission.sql`.
- Telegram's last reported webhook error: `503 Service Unavailable`.
- Pending Telegram updates were non-zero at the time of the check.

A healthy Core health endpoint does not mean the queue or Telegram webhook is healthy.

## 4. Current architectural risks

### P0 — Single global Durable Object

The Worker routes the fixed name `connection-links-v1` to one `ConnectionLinkStore`. That class owns unrelated concerns and is on the critical path for replay protection and user/control-plane operations.

The recent Cloudflare error was a Durable Objects Free-tier row-read quota exhaustion. Creating a second Worker without changing the storage access pattern would not reliably solve this: a second Worker could still hit the same account-level resource limits, and duplicating state would introduce consistency problems.

**Direction:** Move high-volume, queryable records to D1 with indexed, bounded SQL operations and atomic uniqueness constraints. Keep Durable Objects only for state that truly requires per-entity coordination. Avoid a single global DO for unrelated user and nonce traffic.

### P0 — Preview is the only provisioned environment

The active Worker and Render service are Preview-oriented. The checked-in main Wrangler config explicitly references the Preview D1 database.

**Direction:** Define a real environment boundary before Production:
- separate Production D1 database and migration ledger;
- explicit Worker environment/configuration and secrets;
- separate Render Production service only if the cost and Free-tier limitations are acceptable;
- a deliberate Telegram webhook cutover plan, since one bot token can have only one active webhook target;
- backup/export and rollback procedures.

Do not relabel Preview resources as Production.

### P1 — Core replay protection is process-local by default

The Core creates an `InMemoryNonceStore` unless a nonce store is injected. This is acceptable only for a single Core process. It is not a safe basis for horizontal scaling or multiple instances.

**Direction:** Keep Core single-instance until shared replay protection is implemented and verified, or move request replay admission to a shared durable store.

### P1 — Catch pipeline is not activated by default

`create_app` accepts an injected `catch_pipeline`, and the incoming handler uses it when present. The application startup does not construct a CatchPipeline automatically. The current default is the manual-review pipeline.

The recognition path is not equivalent to character identification:
- trace.moe provides anime/scene similarity, not definitive character identity;
- the built-in character map is empty;
- the Senpai target is frozen/disabled;
- a confirmed target-bot success response contract is still required.

**Direction:** Keep live Catch disabled. Complete character-level identification, exact target command contract, receipt verification, explicit per-user opt-in, and end-to-end tests before enabling any command.

### P1 — Worker code is too concentrated

The main Worker entry file is a large module containing webhook routing, Telegram UI/authorization, Owner controls, Durable Object logic, and health/queue endpoints.

**Direction:** Refactor by domain behind stable module boundaries, with tests at each boundary. Do not combine this refactor with a Production migration or bot webhook cutover.

### P2 — Documentation drift

The README describes the active Telegram-only design. The roadmap document is explicitly historical and superseded. Other design notes contain older target and authorization assumptions.

**Direction:** Treat this document plus the README as current operational references. Historical documents must remain clearly labeled as historical until reconciled; do not use them as deployment instructions.

## 5. Recommended target architecture

1. **Telegram ingress Worker:** thin webhook/auth/routing layer; bounded request handling and structured observability.
2. **D1 control store:** user registry, invitations, activity summaries, auth challenge metadata, replay nonces, bot pacing/circuit state, review metadata, and job/admission records where transactional semantics fit.
3. **Narrow Durable Objects:** only where serialized per-user or per-conversation coordination is genuinely required. No global catch-all actor.
4. **Python Core:** single execution service for Telethon, recognition, review, and guarded Catch orchestration.
5. **Explicit environment separation:** Preview and Production have separate D1 databases, bindings, secrets, Worker deployments, and Core services.
6. **Bot cutover:** one planned webhook switch after the new path passes health, authorization, replay, and queue tests.

## 6. Stabilization sequence

### Phase 0 — Freeze and baseline
- No new user-facing features.
- No new Worker deployment to the active bot.
- Keep Catch disabled.
- Record the current D1 migration ledger and take an export/backup before data migrations.
- Confirm Render deploy and Worker health after the Cloudflare quota reset.

### Phase 1 — Reduce the quota hotspot
- Measure which Worker routes call `ConnectionLinkStore` and how often.
- Move replay nonce claims to a D1 table with a unique nonce key and expiry index.
- Move user/invite/activity/broadcast records to D1 in bounded, indexed operations.
- Preserve atomic invite consumption and Owner authorization.
- Keep a compatibility adapter during migration; do not dual-write indefinitely.
- Add tests for replay rejection, concurrent invite consumption, user isolation, expiry cleanup, and quota-safe bounded reads.

### Phase 2 — Modularize Worker
- Separate webhook routing, Telegram API safety, authorization, Owner controls, storage adapters, and health/queue routes.
- Keep public route contracts stable.
- Run all Worker tests and a Preview integration test after each extraction.

### Phase 3 — Make Preview reliable
- Confirm D1 queue claim/recovery works after quota reset.
- Confirm Telegram webhook no longer reports 503 and pending updates drain.
- Confirm Core queue failures back off instead of tight-looping.
- Verify that the ten-minute Cron only performs the intended Core liveness check.

### Phase 4 — Create Production isolation
- Create a separate Production D1 only after migration and backup strategy is agreed.
- Prepare Worker Production configuration and secret bindings without attaching the live bot token.
- Provision Core Production only after cost/availability trade-offs are approved.
- Test the complete Production path using a separate test bot/token where possible.
- Perform a controlled webhook cutover with rollback ready.

### Phase 5 — Catch readiness
- Confirm source bot identity and target bot identity.
- Confirm target command grammar and successful response contract from observed evidence.
- Confirm character-level confidence and false-positive thresholds.
- Confirm atomic admission, deduplication, quotas, and manual fallback.
- Run dry-run tests, then a separately approved controlled test.
- Keep live Catch off until all gates pass.

## 7. Operational rules

- Never print, copy into documentation, or commit secret values.
- Never deploy a second Worker against the active bot token before a webhook cutover plan exists.
- Never use the Preview D1 database for Production.
- Never run remote migrations without checking the live migration ledger and taking a backup.
- Never enable Catch because recognition or manual review works.
- Never claim a deployment is healthy from deployment status alone; verify health endpoints, logs, and a representative request.
- Never scale the Python Core horizontally while its replay guard is process-local.
- Keep paid infrastructure off unless the user approves the exact cost first.

## 8. Current next actions

1. Verify Render application logs and current queue behavior (requires the correct Render workspace to be selected).
2. Recheck Worker health after the daily Durable Objects quota reset.
3. Audit every `ConnectionLinkStore` call site and classify it as D1, Durable Object, or stateless.
4. Draft the D1 schema/migration for nonce and user-control state, with rollback and backup.
5. Only after the migration design is reviewed, build a separate non-production Worker path.

**Decision:** Do not create or activate `kagecatch-control-v2` yet. First remove the single-global-DO bottleneck and define Preview/Production boundaries. A replacement Worker is a deployment artifact, not an architectural fix.
