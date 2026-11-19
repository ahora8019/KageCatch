import test from "node:test";
import assert from "node:assert/strict";
import { classifyTelegramApiFailure, isTelegramMutatingMethod } from "./telegram_safety.mjs";

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
import { acquireTelegramSendPermit, waitForTelegramSendPermit, acquireTelegramChatPermit, waitForTelegramChatPermit, recordTelegramApiFailure, TelegramSafetyGateError } from "./telegram_safety.mjs";

function safetyDb(initial = {}) {
  const state = {
    paused_until_ms: initial.paused_until_ms ?? 0,
    next_allowed_at_ms: initial.next_allowed_at_ms ?? 0,
    pause_reason: initial.pause_reason ?? null,
    chats: new Map(),
  };
  return {
    state,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          const v = this.values;
          if (sql.includes("UPDATE telegram_bot_chat_pacing")) {
            const [now, interval, chatId, checkNow] = v;
            const current = state.chats.get(chatId) ?? 0;
            if (current > checkNow) return null;
            state.chats.set(chatId, now + interval);
            return { next_allowed_at_ms: now + interval };
          }
          if (sql.includes("SELECT next_allowed_at_ms FROM telegram_bot_chat_pacing")) {
            return { next_allowed_at_ms: state.chats.get(v[0]) ?? 0 };
          }
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
          if (sql.startsWith("INSERT INTO telegram_bot_chat_pacing")) {
            if (!state.chats.has(v[0])) state.chats.set(v[0], 0);
          } else if (sql.includes("paused_until_ms = MAX")) {
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
  await assert.rejects(() => acquireTelegramSendPermit(db, 1500, 1000), (error) => error instanceof TelegramSafetyGateError && error.kind === "cooldown" && error.retryAfterMs === 500);
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


test("concurrent outbound operations serialize through the shared permit instead of failing immediately", async () => {
  const db = safetyDb();
  const started = Date.now();
  await Promise.all([
    waitForTelegramSendPermit(db, 80, 1000),
    waitForTelegramSendPermit(db, 80, 1000),
  ]);
  assert.ok(Date.now() - started >= 60);
  assert.ok(db.state.next_allowed_at_ms >= started + 80);
});


test("group sends use a durable per-chat cooldown while different groups remain independent", async () => {
  const db = safetyDb();
  const started = Date.now();
  await Promise.all([
    waitForTelegramChatPermit(db, -100123456, 80, 1000),
    waitForTelegramChatPermit(db, -100123456, 80, 1000),
    waitForTelegramChatPermit(db, -100654321, 80, 1000),
  ]);
  assert.ok(Date.now() - started >= 60);
  assert.equal(db.state.chats.size, 2);
  assert.ok(db.state.chats.get("-100123456") >= started + 80);
});

test("private chats do not consume the group pacing budget", async () => {
  const db = safetyDb();
  assert.deepEqual(await acquireTelegramChatPermit(db, 123456, 1000, 3100), { allowed: true, retryAfterMs: 0 });
  assert.equal(db.state.chats.size, 0);
});


test("unknown Telegram Bot API methods fail closed as mutating unless explicitly read-only", () => {
  assert.equal(isTelegramMutatingMethod("getMe"), false);
  assert.equal(isTelegramMutatingMethod("getWebhookInfo"), false);
  assert.equal(isTelegramMutatingMethod("sendMessage"), true);
  assert.equal(isTelegramMutatingMethod("futureTelegramMutation"), true);
  assert.equal(isTelegramMutatingMethod("setChatPermissions"), true);
});
