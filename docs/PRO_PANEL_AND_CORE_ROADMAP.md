# KageCatch Professional Panel and Core Roadmap

## Product direction

KageCatch uses a Telegram-first experience:
- Telegram bot: notifications, quick actions, account and owner controls.
- Telegram Mini App: responsive Persian RTL dashboard for mobile and desktop.
- Cloudflare Worker: bot webhook, role checks, Mini App initData verification, and control-plane APIs.
- Python execution plane: Telethon session runtime, spawn ingestion, recognition, and catch orchestration.

## Current branch scope

This branch introduces the first professional Mini App UI and its initial identity boundary:
- Responsive RTL dashboard with overview, accounts, Catch settings, activity, security, settings, and owner sections.
- Telegram bot menus launch the dashboard using a private-chat Web App button.
- The Worker validates Telegram Mini App initData with HMAC-SHA-256 and a five-minute freshness window.
- The session endpoint resolves MEMBER/OWNER from the server-side registry; it never trusts a role supplied by the browser.
- The UI reports Python Core as disconnected. Account and Catch operations remain disabled until the execution API is deployed.

## Security rules

- Never collect Telegram OTPs, 2FA passwords, API hashes, Fernet keys, or StringSessions in bot messages or browser forms.
- Treat Mini App initData as untrusted until the Worker verifies its signature and auth_date.
- Do not trust user ID, role, or status sent separately by the client.
- Owner-only data and actions must be checked again on the server for every request.
- Session ciphertext is stored only by the Python execution plane; encryption keys stay in the host secret manager.
- A successful link click is not proof of Telegram authorization.
- A sent Catch command is not a successful Catch; only the destination bot's verified response counts.

## Delivery phases

### Phase A — Product shell
- Professional Mini App interface and bot launch entry.
- Live Control Worker health indicator.
- Truthful empty states for unavailable Core-backed features.

### Phase B — Authenticated control plane
- Validate Mini App initData server-side.
- Return identity and role from the server-side user registry.
- Add authenticated account, settings, activity, and owner APIs.
- Add CSRF/replay considerations, rate limits, audit events, and authorization tests.

### Phase C — Python Core service
- Expose a small authenticated health and command API.
- Establish Worker-to-Core request authentication, idempotency keys, bounded retries, and timeouts.
- Add durable job handoff; never hold long-running Telethon work inside a Worker request.
- Deploy a persistent Python execution host and managed persistent storage.

### Phase D — Secure account authorization

The currently wired Core authorization path is the browser-based Phone Login flow, not the standalone QR class:
- The private Control Bot issues a short-lived, one-time HTTPS connection link. The browser page accepts the phone number, Telegram OTP, and (when Telegram requires it) the 2FA password; these values are not collected in bot chat.
- The browser submits them through authenticated Worker endpoints. The Worker forwards requests to the Python Core using timestamped HMAC authentication, a nonce/replay check, and a bounded request body.
- The Core exposes authenticated `connect`, `connect/code`, `connect/password`, `connect/status`, and `connect/cancel` endpoints. These endpoints do accept OTP/2FA values from the trusted Worker transport; therefore the older statement that Core has no OTP/2FA submission endpoints was incorrect.
- The authorization state machine does not store the OTP or 2FA password. It stores only the pending challenge metadata and a temporary Telethon StringSession encrypted through SessionManager. The final authorized StringSession is persisted encrypted only after Telethon confirms authorization.
- If final persistence is temporarily unavailable after Telegram has authorized the account, the Core keeps an encrypted authorized-session checkpoint and returns `persistence_pending`. Status polling (or process restart when the checkpoint is durable) retries persistence without asking for the OTP/2FA value again. A cancel action cannot discard an already-authorized session awaiting persistence.
- The separate `TelegramQrAuthorizationFlow` class exists, but is not wired into the current Core API or the browser connection page. Do not describe it as the active account-connection path.
- Account status, disconnect, explicit reconnect, and revoke endpoints are implemented. Session listing, key rotation, and session access auditing remain to be completed.
- This authorization path has unit-level coverage only. No real Telegram account has been connected or validated; require explicit user approval and a controlled end-to-end security review before enabling real-account use.

### Phase E — Recognition and Catch
- Spawn Detector → Core incoming-listener routing → guarded CatchPipeline integration are implemented; when CatchPipeline is not injected, the prior manual-review-only pipeline remains the default.
- CatchPipeline requires explicit character identity/confidence, atomic admission, an enabled engine, per-user opt-in, and a matching target adapter. Otherwise it routes the already-detected spawn to manual review.
- Image/video frame recognition with calibrated character-level confidence remains incomplete. trace.moe scene similarity and anime-to-cast mappings must not be used as character identity.
- Target-specific response listeners/verifiers are still required before any sent command can be trusted as verified.
- Start in dry-run/paper mode; no live Catch until end-to-end tests pass.

## Deployment policy

This branch is not deployed. The existing production Worker remains unchanged until the branch passes its checks and the owner explicitly approves a production deployment. No real broadcast or Catch test is performed as part of a UI deployment.


## Hosting gate (zero-budget constraint)

The Python Core requires a persistent process and durable storage for Telethon clients and encrypted sessions. Do not treat a sleeping serverless/free web service as production hosting:
- Render's free web services spin down after 15 minutes without inbound traffic and use an ephemeral filesystem by default: https://render.com/docs/faq
- Koyeb's free instance scales to zero after one hour, cannot use Volumes, and cannot be used as a Worker Service: https://www.koyeb.com/docs/reference/instances
- Cloudflare Workers can make outbound TCP connections, but sockets cannot be created globally and shared across requests; this is not a persistent Telethon process host: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

Oracle Cloud Always Free is a candidate for a single persistent VM and block storage, subject to account eligibility, card/phone verification, regional capacity, and idle-instance reclamation: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

Until a suitable persistent host is available, the Core API and account flow remain development-only. Do not store real Telegram sessions on an ephemeral filesystem or enable production Catch.
