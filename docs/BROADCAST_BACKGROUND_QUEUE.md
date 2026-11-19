# Broadcast Background Queue — Design and Safety Notes

**Status:** Architecture proposal for the Control Bot. The current implementation is still synchronous; the durable alarm-driven queue described below is not yet implemented.

## 1. Current execution path and limits

The Owner confirmation callback is handled by `handleWebhook()` → `handleCallback()` → `handleOwnerCallback()`. The `owner:broadcast:confirm` branch currently:

1. Claims the Owner's draft in the `ConnectionLinkStore` Durable Object.
2. Snapshots active MEMBER Telegram IDs, sorted and deduplicated, if the recipient snapshot does not already exist.
3. Sends each message sequentially from the webhook callback.
4. Advances the Durable Object cursor after each confirmed Telegram API success or recipient-specific 400/403 rejection.
5. Sleeps 50 ms between recipients and returns only after the whole loop stops or finishes.

The recipient snapshot is capped at 5,000 IDs. The draft, cursor, and counters survive Worker restarts because they are stored in Durable Object storage. However, the webhook request remains open for the entire loop. The early `answerCallbackQuery` only dismisses Telegram's spinner; it does not detach the work from the webhook response. A large audience can therefore exceed practical webhook/Worker execution windows, cause Telegram to retry the update, and leave a durable draft in `sending` if the invocation terminates before its release/clear path.

## 2. Existing idempotency and resume semantics

- The Durable Object `claim` action uses a transaction and changes `awaiting_confirmation` to `sending`; a second confirmation cannot claim the same draft concurrently.
- Recipient IDs are snapshotted once. The snapshot is not rebuilt on resume.
- `advance` is compare-and-set: it requires the expected `nextIndex` and advances exactly one stored cursor position.
- Confirmed successes and definite recipient-specific 400/403 failures are counted before moving to the next recipient.
- A safety stop releases the draft to `awaiting_confirmation` without advancing the current cursor. A later explicit Owner confirmation resumes at the saved `nextIndex`.
- This is internal state idempotency, not exactly-once Telegram delivery. Telegram `sendMessage` has no idempotency key accepted by this integration.

## 3. Safety Gate behavior

All outbound mutating Bot API calls pass through the central `telegramApi()` path:

- The global D1-backed send permit enforces the application-level spacing.
- Per-chat pacing is checked before the request.
- An open per-chat Circuit Breaker fails closed.
- Telegram 429 persists `retry_after` (with a bounded fallback); the broadcast stops and keeps its current cursor.
- Telegram 401 creates an operator-required global pause; the broadcast stops and cannot make progress until an Owner reviews and recovers the credential pause.
- Recipient-specific 400/403 responses are treated as definite recipient failures and advance the cursor; repeated qualifying failures can open only that chat's circuit.
- A missing or unavailable durable safety store fails closed before the Bot API request.

The current safety gate is an application safeguard, not a guarantee against every Telegram restriction.

## 4. Duplicate delivery and ambiguous network outcomes

There is an unavoidable boundary between Telegram accepting a message and KageCatch durably advancing `nextIndex`. If Telegram accepts the message but the response is lost, the response body cannot be parsed, a 5xx is returned, or the Worker fails before the cursor write, KageCatch cannot know whether the recipient received the message.

The current generic failure path releases the draft without advancing the cursor. Retrying can therefore send the same recipient again. Conversely, advancing without a confirmed result could skip a message that was never delivered. Neither choice provides exactly-once delivery.

**Required safe behavior:** preserve the current cursor and lock an ambiguous result in an Owner-review state. Do not automatically retry that recipient. The Owner must explicitly decide whether to treat it as delivered or intentionally retry it, understanding that a retry may duplicate a message.

## 5. Recommended background architecture

Use the existing `ConnectionLinkStore` Durable Object and its persistent storage as the first queue implementation; do not add a D1 migration or a new binding for this phase.

1. **Fast webhook handoff:** after Owner authorization and explicit confirmation, snapshot recipients, atomically change the broadcast to `queued`, schedule a Durable Object alarm, and return the webhook response. Do not send the recipient batch in the webhook callback.
2. **Durable alarm worker:** process one recipient (or a very small bounded batch) per alarm invocation. Persist the current recipient/index and an attempt identifier before calling Telegram.
3. **Confirmed result:** on a confirmed success or definite recipient-specific rejection, atomically compare-and-set the expected index, update counters, clear the in-flight marker, and schedule the next alarm.
4. **Safety stop:** on a closed Safety Gate, 429, or 401, persist a paused state and leave the current cursor unchanged. A 401 remains blocked until the Owner completes the existing credential recovery flow. Do not spin or repeatedly invoke alarms while the gate is closed.
5. **Ambiguous result:** if the network outcome, Telegram 5xx/unknown response, post-send persistence, or an interrupted in-flight attempt makes delivery uncertain, persist `review_required`, keep the cursor on that recipient, and do not schedule an automatic retry.
6. **Crash recovery:** set a durable watchdog alarm while a recipient is in flight. If a later alarm finds an old in-flight marker, move the broadcast to `review_required`; never assume the send failed and resend automatically.
7. **Owner controls:** expose status and a scoped review action. Resolution must use the expected broadcast ID/index/attempt ID so stale Owner screens cannot resolve a newer attempt. A retry is an explicit at-least-once choice, not an exactly-once guarantee.

Durable Object alarms are preferable to using `ctx.waitUntil()` as the queue itself: `waitUntil` can detach work from a response but is not a durable scheduling/recovery mechanism. The existing registry is a single named Durable Object and the configured deployment has one Owner ID, so its single alarm can serialize one active broadcast. If multiple independent Owners or parallel broadcasts are introduced later, use per-broadcast/per-owner Durable Objects or a separately designed scheduler rather than silently sharing one alarm.

## 6. Scope and operational boundaries

- No new D1 table is required for the first alarm-based version; the existing Durable Object storage is the durable queue record.
- The global and per-chat Safety Gate remains the only outbound path. The queue must not bypass pacing, Circuit Breakers, 401 pause, or 429 retry state.
- Queue transitions and cursor changes must be transactional and compare-and-set.
- Delivery is at-least-once at best when an Owner chooses to retry an ambiguous attempt; it is never advertised as exactly-once.
- Production D1 migrations, bindings, secrets, webhook configuration, live Telegram tests, merge, and deploy remain outside this PR's scope.


## 7. Incremental safeguard now present on PR #44

The full alarm-driven queue remains a follow-up, but the current synchronous path now has a narrow duplicate-prevention guard:

- A non-recipient-specific, non-Safety-Gate failure during a recipient send is treated as ambiguous. This includes a rejected network fetch and Telegram 5xx/unknown responses.
- The Durable Object compare-and-set transition stores `status = review_required`, `reviewIndex`, and the exact `reviewRecipientId`; `nextIndex` and counters do not advance.
- `claim` cannot reclaim this state, and a transactional `begin` guard cannot overwrite it or race a concurrent claim. A repeated confirmation returns the locked Owner notice instead of sending again.
- A 400/403 recipient-specific rejection remains a definite failure and advances the cursor. A closed Safety Gate, 429, or 401 follows the existing pause/release path and does not advance the cursor.
- The Owner can explicitly discard the draft. There is not yet a UI action to mark the uncertain attempt delivered or intentionally retry it; those resolution controls belong in the dedicated queue/review phase.

This guard reduces duplicate risk but does not make the current webhook loop asynchronous or recover an invocation that is terminated before it can persist the review transition.
