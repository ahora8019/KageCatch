import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTelegramChatCircuitClosed,
  recordTelegramChatApiFailure,
  recordTelegramChatApiSuccess,
  TelegramSafetyGateError,
} from "./telegram_safety.mjs";

function circuitDb() {
  const chats = new Map();
  return {
    chats,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          const [chatId, errorCode, now] = values;
          if (sql.includes("INSERT INTO telegram_bot_chat_circuit_breaker")) {
            const current = chats.get(chatId) ?? {
              chat_id: chatId, consecutive_failures: 0, is_open: 0,
              last_error_code: null, updated_at_ms: now,
            };
            current.consecutive_failures = Math.min(3, current.consecutive_failures + 1);
            current.is_open = current.consecutive_failures >= 3 ? 1 : current.is_open;
            current.last_error_code = errorCode;
            current.updated_at_ms = now;
            chats.set(chatId, current);
            return { consecutive_failures: current.consecutive_failures, is_open: current.is_open };
          }
          if (sql.includes("SELECT")) return chats.get(values[0]) ?? null;
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO telegram_bot_chat_circuit_breaker")) {
            const [chatId, now] = values;
            if (!chats.has(chatId)) chats.set(chatId, {
              chat_id: chatId, consecutive_failures: 0, is_open: 0,
              last_error_code: null, updated_at_ms: now,
            });
          } else if (sql.includes("UPDATE telegram_bot_chat_circuit_breaker")) {
            if (sql.includes("consecutive_failures = 0")) {
              const [now, chatId] = values;
              const current = chats.get(chatId);
              if (current) chats.set(chatId, { ...current, consecutive_failures: 0, last_error_code: null, updated_at_ms: now });
            } else {
              const [chatId, failureCount, isOpen, lastErrorCode, now] = values;
              chats.set(chatId, {
                chat_id: chatId, consecutive_failures: failureCount,
                is_open: isOpen, last_error_code: lastErrorCode, updated_at_ms: now,
              });
            }
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

test("three consecutive chat-scoped 403/400 failures open only that chat circuit", async () => {
  const db = circuitDb();
  await recordTelegramChatApiFailure(db, 111, { kind: "access_denied", errorCode: 403 }, 1000);
  await recordTelegramChatApiFailure(db, 111, { kind: "invalid_request", errorCode: 400 }, 2000);
  assert.equal(db.chats.get("111").is_open, 0);
  await recordTelegramChatApiFailure(db, 111, { kind: "access_denied", errorCode: 403 }, 3000);

  await assert.rejects(
    () => assertTelegramChatCircuitClosed(db, 111),
    (error) => error instanceof TelegramSafetyGateError && error.kind === "chat_circuit_open",
  );
  await assertTelegramChatCircuitClosed(db, 222);
});

test("transient, rate-limit, and credential errors do not increment a chat circuit", async () => {
  const db = circuitDb();
  for (const kind of ["transient", "rate_limited", "invalid_credentials", "unknown"]) {
    await recordTelegramChatApiFailure(db, 111, { kind, errorCode: 503 }, 1000);
  }
  assert.equal(db.chats.get("111")?.consecutive_failures ?? 0, 0);
  await assertTelegramChatCircuitClosed(db, 111);
});

test("a successful delivery resets a closed chat circuit's consecutive failure count", async () => {
  const db = circuitDb();
  await recordTelegramChatApiFailure(db, 111, { kind: "access_denied", errorCode: 403 }, 1000);
  await recordTelegramChatApiFailure(db, 111, { kind: "invalid_request", errorCode: 400 }, 2000);
  await recordTelegramChatApiSuccess(db, 111, 3000);
  assert.equal(db.chats.get("111").consecutive_failures, 0);
  await assertTelegramChatCircuitClosed(db, 111);
});

test("an open chat circuit stays fail-closed until operator recovery", async () => {
  const db = circuitDb();
  for (let i = 0; i < 3; i++) {
    await recordTelegramChatApiFailure(db, 111, { kind: "access_denied", errorCode: 403 }, 1000 + i);
  }
  await assert.rejects(() => assertTelegramChatCircuitClosed(db, 111));
  await assert.rejects(
    () => recordTelegramChatApiSuccess(db, 111, 5000),
    /chat_circuit_open/,
  );
});

test("circuit storage failure blocks the operation rather than allowing a send", async () => {
  await assert.rejects(() => assertTelegramChatCircuitClosed(null, 111), /safety_store_unavailable/);
});

test("concurrent permanent failures increment atomically and open at the threshold", async () => {
  const db = circuitDb();
  await Promise.all([1, 2, 3].map((now) =>
    recordTelegramChatApiFailure(db, 333, { kind: "access_denied", errorCode: 403 }, now)
  ));
  assert.equal(db.chats.get("333").consecutive_failures, 3);
  assert.equal(db.chats.get("333").is_open, 1);
});
