import test from "node:test";
import assert from "node:assert/strict";
import { classifyTelegramApiFailure } from "./telegram_safety.mjs";

test("Telegram 429 preserves retry_after as a bounded rate-limit instruction", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 429, parameters: { retry_after: 37 } }, 429),
    { kind: "rate_limited", retryAfterSeconds: 37, errorCode: 429 },
  );
});

test("Telegram 403 is permanent access restriction and is never classified as retryable", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 403 }, 403),
    { kind: "access_denied", retryAfterSeconds: null, errorCode: 403 },
  );
});

test("Telegram 401 is a credential failure, not a transient network error", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 401 }, 401),
    { kind: "invalid_credentials", retryAfterSeconds: null, errorCode: 401 },
  );
});

test("Telegram 5xx is transient but does not authorize an immediate retry", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 503 }, 503),
    { kind: "transient", retryAfterSeconds: null, errorCode: 503 },
  );
});

test("untrusted retry_after values are clamped and malformed values are ignored", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 429, parameters: { retry_after: 999999 } }, 429),
    { kind: "rate_limited", retryAfterSeconds: 86400, errorCode: 429 },
  );
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 429, parameters: { retry_after: "soon" } }, 429),
    { kind: "rate_limited", retryAfterSeconds: null, errorCode: 429 },
  );
});

test("error classification never copies Telegram descriptions into diagnostics", () => {
  const result = classifyTelegramApiFailure({
    ok: false,
    error_code: 400,
    description: "sensitive upstream detail",
  }, 400);
  assert.deepEqual(result, { kind: "invalid_request", retryAfterSeconds: null, errorCode: 400 });
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream detail/);
});
import { acquireTelegramSendPermit, recordTelegramApiFailure, TelegramSafetyGateError } from "./telegram_safety.mjs";

function safetyDb(initial = {}) {
  const state = {
    paused_until_ms: initial.paused_until_ms ?? 0,
    next_allowed_at_ms: initial.next_allowed_at_ms ?? 0,
    pause_reason: initial.pause_reason ?? null,
  };
  return {
    state,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          const v = this.values;
          if (sql.includes("RETURNING")) {
            const [now, interval, pausedCheckNow, nextCheckNow] = v;
            if (state.paused_until_ms > pausedCheckNow || state.next_allowed_at_ms > nextCheckNow) return null;
            state.next_allowed_at_ms = now + interval;
            return { next_allowed_at_ms: state.next_allowed_at_ms };
          }
          if (sql.startsWith("SELECT")) return { ...state };
          return null;
        },
        async run() {
          const v = this.values;
          if (sql.includes("paused_until_ms = MAX")) {
            const [until] = v;
            state.paused_until_ms = Math.max(state.paused_until_ms, until);
            state.pause_reason = "telegram_429";
          } else if (sql.includes("paused_until_ms = 9223372036854775807")) {
            state.paused_until_ms = Number.MAX_SAFE_INTEGER;
            state.pause_reason = v[0];
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

test("global send permit is stored in D1 and enforces a shared cooldown", async () => {
  const db = safetyDb();
  assert.deepEqual(await acquireTelegramSendPermit(db, 1000, 1000), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(await acquireTelegramSendPermit(db, 1500, 1000), { allowed: false, retryAfterMs: 500 });
  assert.deepEqual(await acquireTelegramSendPermit(db, 2000, 1000), { allowed: true, retryAfterMs: 0 });
});

test("global send permit refuses closed when the durable store is unavailable", async () => {
  await assert.rejects(() => acquireTelegramSendPermit(null, 1000, 1000), /safety_store_unavailable/);
});

test("429 persists retry_after as a global backoff", async () => {
  const db = safetyDb();
  await recordTelegramApiFailure(db, { kind: "rate_limited", retryAfterSeconds: 12 }, 5000);
  await assert.rejects(
    () => acquireTelegramSendPermit(db, 5001, 1000),
    (error) => error instanceof TelegramSafetyGateError && error.kind === "rate_limited" && error.retryAfterMs === 11999,
  );
});

test("401 persists an operator-required global pause", async () => {
  const db = safetyDb();
  await recordTelegramApiFailure(db, { kind: "invalid_credentials", retryAfterSeconds: null }, 1000);
  await assert.rejects(
    () => acquireTelegramSendPermit(db, 2000, 1000),
    (error) => error instanceof TelegramSafetyGateError && error.kind === "operator_action_required",
  );
});

test("403 access denial does not globally freeze the bot because it may be chat-specific", async () => {
  const db = safetyDb();
  await recordTelegramApiFailure(db, { kind: "access_denied", retryAfterSeconds: null }, 1000);
  assert.deepEqual(await acquireTelegramSendPermit(db, 2000, 1000), { allowed: true, retryAfterMs: 0 });
});
