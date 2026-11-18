import test from "node:test";
import assert from "node:assert/strict";
import { reserveOutbound, updateTelegramBackoff, setOwnerSafetyLock } from "./telegram_safety.mjs";

function makeDb({ safety = null, pacing = null } = {}) {
  const state = { safety: safety ? { ...safety } : null, pacing: pacing ? { ...pacing } : null, calls: [] };
  return {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              state.calls.push({ sql, values });
              if (sql.includes("INSERT INTO telegram_send_pacing")) {
                const [ownerId, chatId, nextAllowedAt, updatedAt, ownerForGuard, nowA, nowB, pacingNow] = values;
                const blocked = !state.safety || state.safety.owner_id !== ownerForGuard
                  || state.safety.security_locked || state.safety.session_revoked
                  || state.safety.flood_wait_until > nowA || state.safety.bot_retry_after > nowB;
                if (blocked || (state.pacing && state.pacing.owner_id === ownerId
                  && state.pacing.chat_id === chatId && state.pacing.next_allowed_at > pacingNow)) return null;
                state.pacing = { owner_id: ownerId, chat_id: chatId, next_allowed_at: nextAllowedAt, updated_at: updatedAt };
                return { next_allowed_at: nextAllowedAt };
              }
              if (sql.includes("SELECT security_locked")) {
                return state.safety ? { ...state.safety } : null;
              }
              if (sql.includes("SELECT next_allowed_at")) {
                return state.pacing ? { ...state.pacing } : null;
              }
              if (sql.includes("INSERT INTO telegram_safety_state")) {
                const [ownerId, locked, reason, now] = values;
                state.safety = { owner_id: ownerId, security_locked: locked, session_revoked: 0,
                  lock_reason: reason, flood_wait_until: 0, bot_retry_after: 0, updated_at: now };
                return { ...state.safety };
              }
              return null;
            },
            async run() {
              state.calls.push({ sql, values });
              if (sql.includes("UPDATE telegram_safety_state")) {
                const [fieldValue, updatedAt, ownerId] = values;
                if (!state.safety || state.safety.owner_id !== ownerId) return { meta: { changes: 0 } };
                if (sql.includes("flood_wait_until")) state.safety.flood_wait_until = Math.max(state.safety.flood_wait_until, fieldValue);
                if (sql.includes("bot_retry_after")) state.safety.bot_retry_after = Math.max(state.safety.bot_retry_after, fieldValue);
                state.safety.updated_at = updatedAt;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
}

test("outbound reservation fails closed when the shared D1 binding is absent", async () => {
  const result = await reserveOutbound({}, { ownerId: "owner-1", chatId: "chat-1", now: 100 });
  assert.deepEqual(result, { allowed: false, reason: "safety_store_unavailable" });
});

test("outbound reservation atomically records per-owner chat pacing", async () => {
  const db = makeDb({ safety: { owner_id: "owner-1", security_locked: 0, session_revoked: 0,
    flood_wait_until: 0, bot_retry_after: 0 } });
  const result = await reserveOutbound({ KAGECATCH_DB: db }, {
    ownerId: "owner-1", chatId: "chat-1", now: 100, minimumIntervalSeconds: 2,
  });
  assert.deepEqual(result, { allowed: true, nextAllowedAt: 102 });
  assert.match(db.state.calls[0].sql, /INSERT INTO telegram_send_pacing/i);
  assert.match(db.state.calls[0].sql, /NOT EXISTS\s*\(\s*SELECT 1 FROM telegram_safety_state/i);
});

test("outbound reservation denies a locked owner and does not create a pacing reservation", async () => {
  const db = makeDb({ safety: { owner_id: "owner-1", security_locked: 1, session_revoked: 0,
    flood_wait_until: 0, bot_retry_after: 0 }, });
  const result = await reserveOutbound({ KAGECATCH_DB: db }, {
    ownerId: "owner-1", chatId: "chat-1", now: 100,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "safety_or_pacing_blocked");
  assert.equal(db.state.pacing, null);
});

test("outbound reservation denies pacing collisions without extending the existing deadline", async () => {
  const db = makeDb({ pacing: { owner_id: "owner-1", chat_id: "chat-1", next_allowed_at: 105 } });
  const result = await reserveOutbound({ KAGECATCH_DB: db }, {
    ownerId: "owner-1", chatId: "chat-1", now: 100, minimumIntervalSeconds: 2,
  });
  assert.deepEqual(result, { allowed: false, reason: "safety_or_pacing_blocked" });
  assert.equal(db.state.pacing.next_allowed_at, 105);
});

test("Telegram backoff deadlines only move forward", async () => {
  const db = makeDb({ safety: { owner_id: "owner-1", security_locked: 0, session_revoked: 0,
    flood_wait_until: 120, bot_retry_after: 130, updated_at: 1 } });
  await updateTelegramBackoff({ KAGECATCH_DB: db }, { ownerId: "owner-1", kind: "flood_wait", until: 110, now: 100 });
  assert.equal(db.state.safety.flood_wait_until, 120);
  assert.match(db.state.calls[0].sql, /MAX\(flood_wait_until, \?\)/i);
});

test("owner safety lock persists a reason and fails closed when D1 is unavailable", async () => {
  const db = makeDb();
  const result = await setOwnerSafetyLock({ KAGECATCH_DB: db }, {
    ownerId: "owner-1", locked: true, reason: "manual_review", now: 100,
  });
  assert.equal(result.locked, true);
  assert.equal(db.state.safety.lock_reason, "manual_review");
  const unavailable = await setOwnerSafetyLock({}, {
    ownerId: "owner-1", locked: true, reason: "manual_review", now: 100,
  });
  assert.deepEqual(unavailable, { updated: false, reason: "safety_store_unavailable" });
});
