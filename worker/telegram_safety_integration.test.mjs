import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { telegramApi, ConnectionLinkStore } from "./index.mjs";

const BOT_TOKEN = "safety-integration-test-token";
const OWNER_ID = 7135051954;
const OPERATOR_PAUSE = "9223372036854775807";

class FakeSafetyDb {
  constructor(seed = {}) {
    this.global = {
      paused_until_ms: 0,
      next_allowed_at_ms: 0,
      pause_reason: null,
      updated_at: "2026-11-19 22:00:00",
      ...(seed.global || {}),
    };
    this.pacing = new Map();
    this.circuits = new Map(seed.circuits || []);
  }

  prepare(sql) {
    let values = [];
    return {
      bind: (...args) => { values = args; return this.prepareBound(sql, values); },
    };
  }

  prepareBound(sql, boundValues) {
    const db = this;
    return {
      async first() {
        const values = boundValues;
        if (sql.includes("INSERT INTO telegram_bot_chat_circuit_breaker")) {
          const [chatId, errorCode, now] = values;
          const current = db.circuits.get(String(chatId)) || {
            chat_id: String(chatId), consecutive_failures: 0, is_open: 0,
            last_error_code: null, updated_at_ms: now,
          };
          current.consecutive_failures = Math.min(3, current.consecutive_failures + 1);
          current.is_open = current.consecutive_failures >= 3 ? 1 : current.is_open;
          current.last_error_code = errorCode;
          current.updated_at_ms = now;
          db.circuits.set(String(chatId), current);
          return { consecutive_failures: current.consecutive_failures, is_open: current.is_open };
        }
        if (sql.startsWith("SELECT") && sql.includes("FROM telegram_bot_chat_circuit_breaker") && sql.includes("WHERE chat_id = ?")) {
          return db.circuits.get(String(values[0])) || null;
        }
        if (sql.includes("UPDATE telegram_bot_chat_pacing") && sql.includes("RETURNING")) {
          const [now, intervalMs, chatId] = values;
          db.pacing.set(String(chatId), now);
          return { next_allowed_at_ms: now + intervalMs };
        }
        if (sql.startsWith("SELECT next_allowed_at_ms FROM telegram_bot_chat_pacing")) {
          return { next_allowed_at_ms: db.pacing.get(String(values[0])) || 0 };
        }
        if (sql.startsWith("UPDATE telegram_bot_safety SET next_allowed_at_ms") && sql.includes("RETURNING")) {
          const [now, _intervalMs, pausedCheckNow] = values;
          if (Number(db.global.paused_until_ms) > pausedCheckNow) return null;
          db.global.next_allowed_at_ms = now;
          return { next_allowed_at_ms: now };
        }
        if (sql.startsWith("SELECT") && sql.includes("FROM telegram_bot_safety")) {
          return { ...db.global };
        }
        if (sql.startsWith("UPDATE telegram_bot_chat_circuit_breaker") && sql.includes("RETURNING")) {
          const [now, chatId, expectedUpdatedAt] = values;
          const key = String(chatId);
          const current = db.circuits.get(key);
          if (!current || Number(current.is_open) !== 1 || Number(current.updated_at_ms) !== expectedUpdatedAt) return null;
          db.circuits.set(key, {
            ...current, consecutive_failures: 0, is_open: 0,
            last_error_code: null, updated_at_ms: now,
          });
          return { chat_id: key };
        }
        if (sql.startsWith("UPDATE telegram_bot_safety") && sql.includes("RETURNING")) {
          const [expectedUntil, expectedReason, now] = values;
          if (String(db.global.paused_until_ms) !== String(expectedUntil)
            || db.global.pause_reason !== expectedReason
            || Number(expectedUntil) <= Number(now)) return null;
          db.global.paused_until_ms = 0;
          db.global.pause_reason = null;
          return { singleton_id: "control-bot" };
        }
        return null;
      },
      async run() {
        const values = boundValues;
        if (sql.startsWith("INSERT INTO telegram_bot_chat_pacing")) {
          const [chatId] = values;
          if (!db.pacing.has(String(chatId))) db.pacing.set(String(chatId), 0);
        } else if (sql.includes("UPDATE telegram_bot_safety SET paused_until_ms = MAX")) {
          const [until] = values;
          const operatorPauseActive = Number(db.global.paused_until_ms) >= Number.MAX_SAFE_INTEGER;
          db.global.paused_until_ms = Math.max(Number(db.global.paused_until_ms), until);
          if (!operatorPauseActive) db.global.pause_reason = "telegram_429";
        } else if (sql.includes("UPDATE telegram_bot_safety SET paused_until_ms = 9223372036854775807")) {
          db.global.paused_until_ms = OPERATOR_PAUSE;
          db.global.pause_reason = values[0];
        } else if (sql.includes("UPDATE telegram_bot_chat_circuit_breaker") && sql.includes("consecutive_failures = 0")) {
          const [now, chatId] = values;
          const current = db.circuits.get(String(chatId));
          if (current) db.circuits.set(String(chatId), {
            ...current, consecutive_failures: 0, last_error_code: null, updated_at_ms: now,
          });
        }
        return { meta: { changes: 1 } };
      },
      async all() {
        if (sql.includes("FROM telegram_bot_chat_pacing")) {
          return { results: [...db.pacing].map(([chat_id, next_allowed_at_ms]) => ({ chat_id, next_allowed_at_ms })) };
        }
        if (sql.includes("FROM telegram_bot_chat_circuit_breaker")) {
          return { results: [...db.circuits.values()].map((row) => ({ ...row })) };
        }
        return { results: [] };
      },
    };
  }
}

function createDurableObjectState() {
  const values = new Map();
  let tail = Promise.resolve();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async list({ prefix = "" } = {}) {
      return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix)));
    },
    async transaction(callback) {
      const run = tail.then(() => callback(storage));
      tail = run.catch(() => {});
      return run;
    },
  };
  return { storage };
}

function makeWebAppInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "safety-integration-query",
    user: JSON.stringify(user),
  });
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(checkString).digest("hex"));
  return params.toString();
}

async function createOwnerContext(db, actorId = OWNER_ID) {
  const store = new ConnectionLinkStore(createDurableObjectState());
  const register = (telegramUserId) => store.fetch(new Request("https://do.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId, ownerTelegramId: String(OWNER_ID) }),
  }));
  await register(OWNER_ID);
  if (actorId !== OWNER_ID) await register(actorId);
  const binding = {
    idFromName: () => "connection-links-v1",
    get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }),
  };
  return {
    env: {
      KAGECATCH_DB: db,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      OWNER_TELEGRAM_ID: String(OWNER_ID),
      CONNECT_LINKS: binding,
    },
    initData: makeWebAppInitData({ id: actorId, first_name: actorId === OWNER_ID ? "Owner" : "Member" }),
  };
}

function recoveryRequest(initData, chatId, updatedAtMs) {
  return new Request("https://kagecatch-control.ahora-project.workers.dev/api/owner/safety/recover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      initData,
      action: "chat_circuit",
      chat_id: String(chatId),
      confirmation: "RESET_CHAT_CIRCUIT",
      expected_updated_at_ms: updatedAtMs,
    }),
  });
}

test("telegramApi persists a 429 retry_after globally and blocks the next outbound mutation", async () => {
  const db = new FakeSafetyDb();
  const before = Date.now();
  let networkCalls = 0;
  const env = {
    KAGECATCH_DB: db,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    FETCH: async () => {
      networkCalls += 1;
      return new Response(JSON.stringify({
        ok: false, error_code: 429, parameters: { retry_after: 37 },
      }), { status: 429, headers: { "content-type": "application/json" } });
    },
  };

  await assert.rejects(
    () => telegramApi(env, "sendMessage", { chat_id: 2001, text: "test" }),
    (error) => error.kind === "rate_limited" && error.retryAfterSeconds === 37,
  );
  assert.equal(db.global.pause_reason, "telegram_429");
  assert.ok(Number(db.global.paused_until_ms) >= before + 37_000);

  await assert.rejects(
    () => telegramApi(env, "sendMessage", { chat_id: 2002, text: "must not send" }),
    (error) => error.kind === "rate_limited",
  );
  assert.equal(networkCalls, 1);
});

test("telegramApi persists a 401 as an operator-required pause that a later 429 cannot downgrade", async () => {
  const db = new FakeSafetyDb();
  let networkCalls = 0;
  const env = {
    KAGECATCH_DB: db,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    FETCH: async () => {
      networkCalls += 1;
      return new Response(JSON.stringify({ ok: false, error_code: 401 }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    },
  };

  await assert.rejects(
    () => telegramApi(env, "sendMessage", { chat_id: 2001, text: "test" }),
    (error) => error.kind === "invalid_credentials" && error.errorCode === 401,
  );
  assert.equal(db.global.paused_until_ms, OPERATOR_PAUSE);
  assert.equal(db.global.pause_reason, "invalid_credentials");

  await assert.rejects(
    () => telegramApi(env, "sendMessage", { chat_id: 2002, text: "must not send" }),
    (error) => error.kind === "operator_action_required",
  );
  assert.equal(networkCalls, 1);
});

test("real Telegram send path opens only the failing chat circuit and Owner alone can recover it", async () => {
  const db = new FakeSafetyDb();
  const owner = await createOwnerContext(db);
  const otherCircuit = {
    chat_id: "3003", consecutive_failures: 3, is_open: 1,
    last_error_code: 403, updated_at_ms: 8000,
  };
  db.circuits.set("3003", otherCircuit);

  const statuses = [400, 403, 403];
  let networkCalls = 0;
  const env = {
    ...owner.env,
    FETCH: async () => {
      networkCalls += 1;
      const status = statuses.shift();
      return new Response(JSON.stringify({ ok: false, error_code: status }), {
        status, headers: { "content-type": "application/json" },
      });
    },
  };

  for (const expectedCode of [400, 403, 403]) {
    await assert.rejects(
      () => telegramApi(env, "sendMessage", { chat_id: 2001, text: "test" }),
      (error) => error.errorCode === expectedCode,
    );
  }
  assert.equal(db.circuits.get("2001").consecutive_failures, 3);
  assert.equal(db.circuits.get("2001").is_open, 1);
  assert.equal(db.circuits.get("3003").is_open, 1);

  await assert.rejects(
    () => telegramApi(env, "sendMessage", { chat_id: 2001, text: "must not send" }),
    (error) => error.kind === "chat_circuit_open",
  );
  assert.equal(networkCalls, 3);

  const member = await createOwnerContext(db, 2002);
  const denied = await worker.fetch(
    recoveryRequest(member.initData, 2001, db.circuits.get("2001").updated_at_ms),
    member.env,
  );
  assert.equal(denied.status, 403);
  assert.equal(db.circuits.get("2001").is_open, 1);

  const recovered = await worker.fetch(
    recoveryRequest(owner.initData, 2001, db.circuits.get("2001").updated_at_ms),
    owner.env,
  );
  assert.equal(recovered.status, 200);
  assert.equal(db.circuits.get("2001").is_open, 0);
  assert.equal(db.circuits.get("3003").is_open, 1);

  env.FETCH = async () => {
    networkCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const sent = await telegramApi(env, "sendMessage", { chat_id: 2001, text: "after Owner recovery" });
  assert.equal(sent.message_id, 99);
  assert.equal(networkCalls, 4);
});

test("future valid Bot API methods fail closed behind the global gate; malformed names never reach fetch", async () => {
  const db = new FakeSafetyDb({
    global: {
      paused_until_ms: OPERATOR_PAUSE,
      pause_reason: "invalid_credentials",
    },
  });
  let networkCalls = 0;
  const env = {
    KAGECATCH_DB: db,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    FETCH: async () => {
      networkCalls += 1;
      return Response.json({ ok: true, result: {} });
    },
  };

  await assert.rejects(
    () => telegramApi(env, "futureMutation", { chat_id: 2001 }),
    (error) => error.kind === "operator_action_required",
  );
  await assert.rejects(
    () => telegramApi(env, "send-message", {}),
    /invalid_telegram_method/,
  );
  assert.equal(networkCalls, 0);
});
