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

The current Core API deliberately does not expose OTP or 2FA submission endpoints. Account connection must use a Telegram-controlled authorization handoff, not a bot or browser form that collects login credentials.
- Implemented an official Telegram-controlled one-time `tg://login?token=...` deep-link flow; no QR image is rendered.
- The Worker and Core expose signed connect/status/cancel endpoints. The Core stores a session only after Telethon confirms authorization, then encrypts it through SessionManager.
- If Telethon reports `SessionPasswordNeededError`, the flow fails closed; it does not collect a 2FA password.
- Account status, disconnect, explicit reconnect, and revoke endpoints are implemented; session listing and access audit remain to be completed.
- Validate one real account with explicit user approval before enabling multi-user use.

### Phase E — Recognition and Catch
- Spawn ingestion and media normalization.
- Image/video frame recognition with confidence calibration and review gates.
- Quotas, atomic deduplication, adapter dispatch, response listeners, and verified receipts.
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
