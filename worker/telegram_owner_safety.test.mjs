import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "./index.mjs";

const BOT_TOKEN = "owner-safety-test-bot-token";
const OWNER_ID = 7135051954;

function makeWebAppInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAEAA-test-query",
    user: JSON.stringify(user),
  });
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  params.set("hash", hash);
  return params.toString();
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

function createSafetyDb(seed = {}) {
  const state = {
    global: {
      paused_until_ms: 0,
      next_allowed_at_ms: 0,
      pause_reason: null,
      updated_at: "2026-11-19 19:00:00",
      ...(seed.global || {}),
    },
    pacing: new Map((seed.pacing || []).map((row) => [String(row.chat_id), { ...row, chat_id: String(row.chat_id) }])),
    circuits: new Map((seed.circuits || []).map((row) => [String(row.chat_id), { ...row, chat_id: String(row.chat_id) }])),
  };

  return {
    state,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          if (sql.startsWith("SELECT") && sql.includes("FROM telegram_bot_safety")) {
            return { ...state.global };
          }
          if (sql.startsWith("SELECT") && sql.includes("FROM telegram_bot_chat_circuit_breaker") && sql.includes("WHERE chat_id = ?")) {
            return state.circuits.get(String(values[0])) || null;
          }
          if (sql.startsWith("UPDATE telegram_bot_safety") && sql.includes("RETURNING")) {
            const [expectedUntil, expectedReason, now] = values;
            const currentUntil = BigInt(String(state.global.paused_until_ms));
            if (currentUntil !== BigInt(String(expectedUntil))
              || state.global.pause_reason !== expectedReason
              || currentUntil <= BigInt(String(now))) return null;
            state.global.paused_until_ms = 0;
            state.global.pause_reason = null;
            state.global.updated_at = new Date(now).toISOString().slice(0, 19).replace("T", " ");
            return { singleton_id: "control-bot" };
          }
          if (sql.startsWith("UPDATE telegram_bot_chat_circuit_breaker") && sql.includes("RETURNING")) {
            const [now, chatId, expectedUpdatedAt] = values;
            const key = String(chatId);
            const current = state.circuits.get(key);
            if (!current || Number(current.is_open) !== 1 || Number(current.updated_at_ms) !== expectedUpdatedAt) return null;
            state.circuits.set(key, {
              ...current,
              consecutive_failures: 0,
              is_open: 0,
              last_error_code: null,
              updated_at_ms: now,
            });
            return { chat_id: key };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM telegram_bot_chat_pacing")) {
            return { results: [...state.pacing.values()].map((row) => ({ ...row })) };
          }
          if (sql.includes("FROM telegram_bot_chat_circuit_breaker")) {
            return { results: [...state.circuits.values()].map((row) => ({ ...row })) };
          }
          return { results: [] };
        },
      };
    },
  };
}

async function createOwnerEnv({ ownerId = OWNER_ID, actorId = OWNER_ID, db = createSafetyDb(), actorStatus = "active" } = {}) {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  await store.fetch(new Request("https://do.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: ownerId, ownerTelegramId: String(ownerId) }),
  }));
  if (actorId !== ownerId) {
    await store.fetch(new Request("https://do.internal/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegramUserId: actorId, ownerTelegramId: String(ownerId) }),
    }));
    if (actorStatus === "blocked") {
      await store.fetch(new Request("https://do.internal/manage-user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ telegramUserId: actorId, action: "block" }),
      }));
    }
  }
  const binding = {
    idFromName: () => "connection-links-v1",
    get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }),
  };
  return {
    db,
    env: {
      KAGECATCH_DB: db,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      OWNER_TELEGRAM_ID: String(ownerId),
      CONNECT_LINKS: binding,
    },
    initData: makeWebAppInitData({ id: actorId, first_name: actorId === ownerId ? "Owner" : "Member" }),
  };
}

function post(path, payload, env) {
  return worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), env);
}

test("Owner Safety API rejects missing or forged Mini App authentication for reads and recovery", async () => {
  const db = createSafetyDb({
    global: { paused_until_ms: 9223372036854775807n.toString(), pause_reason: "invalid_credentials" },
  });
  const env = {
    KAGECATCH_DB: db,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    OWNER_TELEGRAM_ID: String(OWNER_ID),
  };
  const status = await post("/api/owner/safety/status", {}, env);
  assert.equal(status.status, 401);
  const forged = await post("/api/owner/safety/status", {
    initData: "user=%7B%22id%22%3A" + OWNER_ID + "%7D&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=deadbeef",
  }, env);
  assert.equal(forged.status, 401);
  const forgedRecovery = await post("/api/owner/safety/recover", {
    initData: "user=%7B%22id%22%3A" + OWNER_ID + "%7D&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=deadbeef",
    action: "global_pause",
    confirmation: "RESET_GLOBAL_PAUSE",
    expected_paused_until_ms: "9223372036854775807",
    expected_pause_reason: "invalid_credentials",
  }, env);
  assert.equal(forgedRecovery.status, 401);
  const recovery = await post("/api/owner/safety/recover", {
    action: "global_pause",
    confirmation: "RESET_GLOBAL_PAUSE",
    expected_paused_until_ms: "9223372036854775807",
    expected_pause_reason: "invalid_credentials",
  }, env);
  assert.equal(recovery.status, 401);
  assert.equal(db.state.global.pause_reason, "invalid_credentials");
});

test("a signed MEMBER cannot read Owner safety state or recover global or chat safety gates", async () => {
  const db = createSafetyDb({
    global: { paused_until_ms: 9223372036854775807n.toString(), pause_reason: "invalid_credentials" },
    circuits: [{ chat_id: "111", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: 5000 }],
  });
  const { env, initData } = await createOwnerEnv({ actorId: 2001, db });
  const status = await post("/api/owner/safety/status", { initData }, env);
  assert.equal(status.status, 403);
  const recovery = await post("/api/owner/safety/recover", {
    initData,
    action: "chat_circuit",
    chat_id: "111",
    confirmation: "RESET_CHAT_CIRCUIT",
    expected_updated_at_ms: 5000,
  }, env);
  assert.equal(recovery.status, 403);
  assert.equal(db.state.circuits.get("111").is_open, 1);
  assert.equal(db.state.global.pause_reason, "invalid_credentials");
});

test("Owner Safety Monitor reports global pause, retry_after, per-chat cooldown, stop cause, last error, and timestamps", async () => {
  const now = Date.now();
  const db = createSafetyDb({
    global: {
      paused_until_ms: now + 45_000,
      next_allowed_at_ms: now + 250,
      pause_reason: "telegram_429",
      updated_at: "2026-11-19 20:00:00",
    },
    pacing: [
      { chat_id: "111", next_allowed_at_ms: now + 5000, updated_at: "2026-11-19 20:00:01" },
      { chat_id: "222", next_allowed_at_ms: now - 1000, updated_at: "2026-11-19 19:59:00" },
    ],
    circuits: [
      { chat_id: "111", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: now - 500 },
    ],
  });
  const { env, initData } = await createOwnerEnv({ db });
  const response = await post("/api/owner/safety/status", { initData }, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.global.paused, true);
  assert.equal(body.global.pause_reason, "telegram_429");
  assert.equal(body.global.last_error_code, 429);
  assert.ok(body.global.retry_after_seconds >= 44 && body.global.retry_after_seconds <= 45);
  assert.equal(body.global.cause_of_stop, "telegram_429");
  assert.equal(body.global.updated_at, "2026-11-19 20:00:00");
  const first = body.chats.find((chat) => chat.chat_id === "111");
  assert.equal(first.is_open, true);
  assert.equal(first.consecutive_failures, 3);
  assert.equal(first.last_error_code, 403);
  assert.equal(first.cause_of_stop, "chat_circuit_open");
  assert.ok(first.cooldown_remaining_ms >= 4900);
  assert.equal(first.circuit_updated_at_ms, now - 500);
  const second = body.chats.find((chat) => chat.chat_id === "222");
  assert.equal(second.is_open, false);
  assert.equal(second.last_error_code, null);
  assert.equal(second.cause_of_stop, null);
});

test("401 global pause stays operator-required until an explicitly confirmed Owner recovery", async () => {
  const sentinel = "9223372036854775807";
  const db = createSafetyDb({
    global: { paused_until_ms: sentinel, next_allowed_at_ms: 9000, pause_reason: "invalid_credentials" },
    circuits: [{ chat_id: "222", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: 8000 }],
  });
  const { env, initData } = await createOwnerEnv({ db });
  const before = await post("/api/owner/safety/status", { initData }, env);
  const beforeBody = await before.json();
  assert.equal(beforeBody.global.operator_action_required, true);
  assert.equal(beforeBody.global.last_error_code, 401);

  const missingConfirmation = await post("/api/owner/safety/recover", {
    initData,
    action: "global_pause",
    expected_paused_until_ms: sentinel,
    expected_pause_reason: "invalid_credentials",
  }, env);
  assert.equal(missingConfirmation.status, 400);
  assert.equal(db.state.global.pause_reason, "invalid_credentials");

  const denied = await post("/api/owner/safety/recover", {
    initData,
    action: "global_pause",
    confirmation: "RESET_GLOBAL_PAUSE",
    expected_paused_until_ms: sentinel,
    expected_pause_reason: "invalid_credentials",
  }, env);
  assert.equal(denied.status, 200);
  assert.equal(db.state.global.paused_until_ms, 0);
  assert.equal(db.state.global.pause_reason, null);
  assert.equal(db.state.global.next_allowed_at_ms, 9000);
  assert.equal(db.state.circuits.get("222").is_open, 1);
});

test("Owner chat recovery closes only the selected circuit and preserves global pause, pacing, and other circuits", async () => {
  const db = createSafetyDb({
    global: { paused_until_ms: 9223372036854775807n.toString(), pause_reason: "invalid_credentials" },
    pacing: [
      { chat_id: "111", next_allowed_at_ms: 12000, updated_at: "2026-11-19 20:00:00" },
      { chat_id: "222", next_allowed_at_ms: 13000, updated_at: "2026-11-19 20:00:01" },
    ],
    circuits: [
      { chat_id: "111", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: 5000 },
      { chat_id: "222", consecutive_failures: 3, is_open: 1, last_error_code: 400, updated_at_ms: 6000 },
    ],
  });
  const { env, initData } = await createOwnerEnv({ db });
  const response = await post("/api/owner/safety/recover", {
    initData,
    action: "chat_circuit",
    chat_id: "111",
    confirmation: "RESET_CHAT_CIRCUIT",
    expected_updated_at_ms: 5000,
  }, env);
  assert.equal(response.status, 200);
  assert.equal(db.state.circuits.get("111").is_open, 0);
  assert.equal(db.state.circuits.get("111").consecutive_failures, 0);
  assert.equal(db.state.circuits.get("111").last_error_code, null);
  assert.equal(db.state.circuits.get("222").is_open, 1);
  assert.equal(db.state.circuits.get("222").consecutive_failures, 3);
  assert.equal(db.state.global.pause_reason, "invalid_credentials");
  assert.equal(db.state.pacing.get("111").next_allowed_at_ms, 12000);
  assert.equal(db.state.pacing.get("222").next_allowed_at_ms, 13000);
});

test("Owner recovery rejects stale chat circuit state and invalid chat identifiers without changing anything", async () => {
  const db = createSafetyDb({
    circuits: [{ chat_id: "111", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: 5000 }],
  });
  const { env, initData } = await createOwnerEnv({ db });
  const stale = await post("/api/owner/safety/recover", {
    initData, action: "chat_circuit", chat_id: "111",
    confirmation: "RESET_CHAT_CIRCUIT", expected_updated_at_ms: 4999,
  }, env);
  assert.equal(stale.status, 409);
  const invalid = await post("/api/owner/safety/recover", {
    initData, action: "chat_circuit", chat_id: "bad/id",
    confirmation: "RESET_CHAT_CIRCUIT", expected_updated_at_ms: 5000,
  }, env);
  assert.equal(invalid.status, 400);
  assert.equal(db.state.circuits.get("111").is_open, 1);
});

test("global Owner recovery rejects stale pause snapshots and never clears an unrelated chat circuit", async () => {
  const now = Date.now();
  const db = createSafetyDb({
    global: { paused_until_ms: now + 60_000, pause_reason: "telegram_429" },
    circuits: [{ chat_id: "999", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: 7000 }],
  });
  const { env, initData } = await createOwnerEnv({ db });
  const stale = await post("/api/owner/safety/recover", {
    initData, action: "global_pause", confirmation: "RESET_GLOBAL_PAUSE",
    expected_paused_until_ms: String(now + 59_999), expected_pause_reason: "telegram_429",
  }, env);
  assert.equal(stale.status, 409);
  assert.equal(db.state.global.pause_reason, "telegram_429");
  assert.equal(db.state.circuits.get("999").is_open, 1);
});

test("Owner dashboard exposes the Safety Monitor and requires a deliberate recovery confirmation", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="safety-status"/);
  assert.match(html, /refreshSafetyMonitor/);
  assert.match(html, /RESET_GLOBAL_PAUSE/);
  assert.match(html, /RESET_CHAT_CIRCUIT/);
  assert.match(html, /data-view="admin"/);
  assert.match(html, /\\d\{4\}/, "the rendered panel must preserve the date-format regex backslash");
});
