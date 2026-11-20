import test from "node:test";
import assert from "node:assert/strict";
import worker, { ConnectionLinkStore } from "./index.mjs";

const BOT_TOKEN = "owner-safety-bot-test-token";
const OWNER_ID = 7135051954;
const WEBHOOK_SECRET = "owner-safety-webhook-test-secret";
const OPERATOR_PAUSE = "9223372036854775807";

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
      updated_at: "2026-11-20 10:00:00",
      ...(seed.global || {}),
    },
    pacing: new Map(),
    circuits: new Map((seed.circuits || []).map((row) => [String(row.chat_id), { ...row, chat_id: String(row.chat_id) }])),
  };
  return {
    state,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          if (sql.startsWith("UPDATE telegram_bot_safety SET next_allowed_at_ms") && sql.includes("RETURNING")) {
            const [now, intervalMs] = values;
            state.global.next_allowed_at_ms = now + intervalMs;
            return { next_allowed_at_ms: state.global.next_allowed_at_ms };
          }
          if (sql.startsWith("UPDATE telegram_bot_chat_pacing") && sql.includes("RETURNING")) {
            const [now, intervalMs, chatId] = values;
            state.pacing.set(String(chatId), now + intervalMs);
            return { next_allowed_at_ms: now + intervalMs };
          }
          if (sql.startsWith("SELECT next_allowed_at_ms FROM telegram_bot_chat_pacing")) {
            return { next_allowed_at_ms: state.pacing.get(String(values[0])) || 0 };
          }
          if (sql.startsWith("SELECT") && sql.includes("FROM telegram_bot_safety")) return { ...state.global };
          if (sql.startsWith("UPDATE telegram_bot_safety") && sql.includes("RETURNING")) {
            const [expectedUntil, expectedReason, now] = values;
            const currentUntil = BigInt(String(state.global.paused_until_ms));
            if (currentUntil !== BigInt(String(expectedUntil))
              || state.global.pause_reason !== expectedReason
              || currentUntil <= BigInt(String(now))) return null;
            state.global.paused_until_ms = 0;
            state.global.pause_reason = null;
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
          if (sql.includes("FROM telegram_bot_chat_pacing")) return { results: [...state.pacing.entries()].map(([chat_id, next_allowed_at_ms]) => ({ chat_id, next_allowed_at_ms })) };
          if (sql.includes("FROM telegram_bot_chat_circuit_breaker")) return { results: [...state.circuits.values()].map((row) => ({ ...row })) };
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO telegram_bot_chat_pacing")) {
            const [chatId] = values;
            if (!state.pacing.has(String(chatId))) state.pacing.set(String(chatId), 0);
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

async function createOwnerEnv(db) {
  const store = new ConnectionLinkStore(createDurableObjectState());
  await store.fetch(new Request("https://do.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: OWNER_ID, ownerTelegramId: String(OWNER_ID) }),
  }));
  const calls = [];
  const env = {
    KAGECATCH_DB: db,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OWNER_TELEGRAM_ID: String(OWNER_ID),
    CONNECT_LINKS: {
      idFromName: () => "connection-links-v1",
      get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }),
    },
    FETCH: async (url, init) => {
      const method = String(url).split("/").pop();
      const payload = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, payload });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { env, calls };
}

async function pressOwnerButton(env, data, updateId) {
  return worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: "safety-callback-" + updateId,
        from: { id: OWNER_ID, first_name: "Owner" },
        message: { message_id: updateId, chat: { id: OWNER_ID, type: "private" } },
        data,
      },
    }),
  }), env);
}

function lastEditedMessage(calls) {
  return calls.filter((call) => call.method === "editMessageText").at(-1)?.payload;
}

function buttons(message) {
  return (message?.reply_markup?.inline_keyboard || []).flat();
}

test("Owner safety state is displayed and controlled entirely inside the Telegram bot", async () => {
  const db = createSafetyDb({
    global: { paused_until_ms: OPERATOR_PAUSE, pause_reason: "invalid_credentials" },
    circuits: [{ chat_id: "-1001234567890", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: 1760000000000 }],
  });
  const { env, calls } = await createOwnerEnv(db);

  const response = await pressOwnerButton(env, "owner:safety", 101);
  assert.equal(response.status, 200);
  const message = lastEditedMessage(calls);
  assert.match(message.text, /وضعیت ایمنی/);
  assert.match(message.text, /401/);
  assert.match(message.text, /-1001234567890/);
  const globalAction = buttons(message).find((button) => button.callback_data?.startsWith("owner:safety:prepare:g:"));
  const chatAction = buttons(message).find((button) => button.callback_data?.startsWith("owner:safety:prepare:c:"));
  assert.ok(globalAction, "global recovery must be available from the bot");
  assert.ok(chatAction, "chat circuit recovery must be available from the bot");
  assert.ok(globalAction.callback_data.length <= 64);
  assert.ok(chatAction.callback_data.length <= 64);
});

test("global Telegram safety recovery requires a separate confirmation and rejects stale snapshots", async () => {
  const db = createSafetyDb({
    global: { paused_until_ms: OPERATOR_PAUSE, pause_reason: "invalid_credentials" },
  });
  const { env, calls } = await createOwnerEnv(db);

  await pressOwnerButton(env, "owner:safety", 201);
  const statusMessage = lastEditedMessage(calls);
  const prepare = buttons(statusMessage).find((button) => button.callback_data?.startsWith("owner:safety:prepare:g:"));
  assert.ok(prepare);

  await pressOwnerButton(env, prepare.callback_data, 202);
  const confirmationMessage = lastEditedMessage(calls);
  assert.match(confirmationMessage.text, /تأیید/);
  const confirm = buttons(confirmationMessage).find((button) => button.callback_data?.startsWith("owner:safety:confirm:g:"));
  assert.ok(confirm);
  assert.equal(db.state.global.pause_reason, "invalid_credentials");

  db.state.global.paused_until_ms = Date.now() + 120000;
  db.state.global.pause_reason = "telegram_429";
  await pressOwnerButton(env, confirm.callback_data, 203);
  assert.equal(db.state.global.pause_reason, "telegram_429");
  assert.match(lastEditedMessage(calls).text, /تغییر کرده|قدیمی/);

  await pressOwnerButton(env, "owner:safety", 204);
  const refreshed = lastEditedMessage(calls);
  const newPrepare = buttons(refreshed).find((button) => button.callback_data?.startsWith("owner:safety:prepare:g:"));
  await pressOwnerButton(env, newPrepare.callback_data, 205);
  const newConfirm = buttons(lastEditedMessage(calls)).find((button) => button.callback_data?.startsWith("owner:safety:confirm:g:"));
  await pressOwnerButton(env, newConfirm.callback_data, 206);
  assert.equal(db.state.global.pause_reason, null);
  assert.equal(db.state.global.paused_until_ms, 0);
  assert.match(lastEditedMessage(calls).text, /رفع شد|برطرف شد/);
});

test("chat circuit recovery is scoped to the selected chat and requires confirmation", async () => {
  const db = createSafetyDb({
    circuits: [
      { chat_id: "111", consecutive_failures: 3, is_open: 1, last_error_code: 403, updated_at_ms: 1760000000000 },
      { chat_id: "222", consecutive_failures: 3, is_open: 1, last_error_code: 400, updated_at_ms: 1760000001000 },
    ],
  });
  const { env, calls } = await createOwnerEnv(db);

  await pressOwnerButton(env, "owner:safety", 301);
  const statusMessage = lastEditedMessage(calls);
  const prepare = buttons(statusMessage).find((button) => button.callback_data?.startsWith("owner:safety:prepare:c:111:"));
  assert.ok(prepare);
  await pressOwnerButton(env, prepare.callback_data, 302);
  const confirmationMessage = lastEditedMessage(calls);
  const confirm = buttons(confirmationMessage).find((button) => button.callback_data?.startsWith("owner:safety:confirm:c:111:"));
  assert.ok(confirm);
  await pressOwnerButton(env, confirm.callback_data, 303);

  assert.equal(db.state.circuits.get("111").is_open, 0);
  assert.equal(db.state.circuits.get("111").consecutive_failures, 0);
  assert.equal(db.state.circuits.get("222").is_open, 1);
  assert.match(lastEditedMessage(calls).text, /مدار|گفت‌وگو|رفع شد/);
});

test("Mini App and browser safety routes remain unavailable", async () => {
  const db = createSafetyDb();
  const { env } = await createOwnerEnv(db);
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/owner/safety/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), env);
  assert.equal(response.status, 404);
});
