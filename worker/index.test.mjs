import "./panel_queue.test.mjs";
import "./telegram_login_ui.test.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import worker, { buildMainMenu, buildRoleMenu, buildStartMenu, resolveRole, resolveCallback, commandReply, isSavedAccountStatus } from "./index.mjs";



test("main menu restores the compact two-row control-center layout", () => {
  const menu = buildMainMenu();
  const callbacks = menu.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.equal(menu.inline_keyboard.length, 2);
  assert.deepEqual(callbacks, ["catch:open", "account:open", "stats:open", "settings:open"]);
  assert.equal(menu.inline_keyboard.flat().some((button) => button.url), false);
});

test("account submenu keeps connection, account list, security and disconnect accessible", () => {
  const result = resolveCallback("account:open");
  const callbacks = result.keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(callbacks, [
    "account:connect", "account:list", "security:open", "account:disconnect", "menu:main",
  ]);
});

test("connect callback starts a Telegram-native phone and keypad login flow", () => {
  const result = resolveCallback("account:connect");
  assert.match(result.text, /شماره تلفنت/);
  assert.match(result.text, /صفحه‌کلید داخل همین بات/);
  assert.doesNotMatch(result.text, /لینک مخصوص|صفحهٔ ورود باز بشه/);
});

test("account and security callbacks disclose only current unavailable state", () => {
  assert.match(resolveCallback("account:list").text, /گزینهٔ «اتصال حساب»/);
  assert.match(resolveCallback("security:open").text, /از سرور KageCatch عبور می‌کنند/);
  assert.match(resolveCallback("account:disconnect").text, /حساب متصلی ثبت نشده/);
});

test("unknown callback is rejected safely", () => {
  assert.equal(resolveCallback("account:unknown").alert, true);
});

test("/start uses the minimal KageCatch control-center heading", () => {
  const start = commandReply("/start");
  assert.match(start.text, /🌸 ━━━ KAGECATCH ━━━/);
  assert.match(start.text, /پنل کنترل \/ CONTROL CENTER/);
  const callbacks = start.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("catch:open"));
  assert.ok(callbacks.includes("account:open"));
  assert.equal(start.reply_markup.inline_keyboard.length, 2);
});

test("/panel opens the compact member menu directly", () => {
  const panel = commandReply("/panel");
  const callbacks = panel.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("account:open"));
  assert.ok(callbacks.includes("catch:open"));
  assert.equal(panel.reply_markup.inline_keyboard.length, 2);
});

test("owner menu is compact and does not duplicate member controls", () => {
  const menu = buildStartMenu("OWNER");
  const callbacks = menu.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.equal(menu.inline_keyboard.length, 4);
  assert.deepEqual(callbacks, [
    "owner:stats", "owner:monitor", "owner:members", "owner:invites",
    "owner:settings", "owner:safety", "owner:broadcast", "owner:emergency",
  ]);
  assert.equal(callbacks.some((callback) => callback.startsWith("catch:") || callback.startsWith("account:")), false);
});

test("status and help remain available as slash-command shortcuts", () => {
  assert.match(commandReply("/status").text, /Python Core: متصل نیست/);
  assert.match(commandReply("/help").text, /کنترل Catch/);
});


function createTelegramSafetyDb() {
  const state = { paused_until_ms: 0, next_allowed_at_ms: 0, pause_reason: null, chats: new Map(), circuits: new Map() };
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          if (sql.includes("INSERT INTO telegram_bot_chat_circuit_breaker")) {
            const [chatId, errorCode, now] = values;
            const current = state.circuits.get(chatId) ?? {
              consecutive_failures: 0, is_open: 0, last_error_code: null, updated_at_ms: now,
            };
            current.consecutive_failures = Math.min(3, current.consecutive_failures + 1);
            current.is_open = current.consecutive_failures >= 3 ? 1 : current.is_open;
            current.last_error_code = errorCode;
            current.updated_at_ms = now;
            state.circuits.set(chatId, current);
            return { consecutive_failures: current.consecutive_failures, is_open: current.is_open };
          }
          if (sql.includes("SELECT consecutive_failures")) {
            return state.circuits.get(values[0]) ?? null;
          }
          if (sql.includes("UPDATE telegram_bot_chat_pacing")) {
            const [now, intervalMs, chatId, checkNow] = values;
            const current = state.chats.get(chatId) ?? 0;
            if (current > checkNow) return null;
            state.chats.set(chatId, now + intervalMs);
            return { next_allowed_at_ms: now + intervalMs };
          }
          if (sql.includes("SELECT next_allowed_at_ms FROM telegram_bot_chat_pacing")) {
            return { next_allowed_at_ms: state.chats.get(values[0]) ?? 0 };
          }
          if (sql.includes("RETURNING")) {
            const [now, intervalMs, pausedCheckNow, nextCheckNow] = values;
            if (state.paused_until_ms > pausedCheckNow || state.next_allowed_at_ms > nextCheckNow) return null;
            state.next_allowed_at_ms = now + intervalMs;
            return { next_allowed_at_ms: state.next_allowed_at_ms };
          }
          if (sql.startsWith("SELECT")) return { ...state };
          return null;
        },
        async run() {
          if (sql.includes("UPDATE telegram_bot_chat_circuit_breaker") && sql.includes("consecutive_failures = 0")) {
            const [now, chatId] = values;
            const current = state.circuits.get(chatId);
            if (current) state.circuits.set(chatId, { ...current, consecutive_failures: 0, last_error_code: null, updated_at_ms: now });
          } else if (sql.startsWith("INSERT INTO telegram_bot_chat_pacing")) {
            if (!state.chats.has(values[0])) state.chats.set(values[0], 0);
          } else if (sql.includes("paused_until_ms = MAX")) {
            state.paused_until_ms = Math.max(state.paused_until_ms, values[0]);
            state.pause_reason = "telegram_429";
          } else if (sql.includes("paused_until_ms = 9223372036854775807")) {
            state.paused_until_ms = Number.MAX_SAFE_INTEGER;
            state.pause_reason = values[0];
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}


function createDurableObjectState({ maxListLimit = Infinity } = {}) {
  const values = new Map();
  let tail = Promise.resolve();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async list({ prefix = "", startAfter, limit = Infinity } = {}) {
      if (limit !== Infinity && limit > maxListLimit) throw new Error("Durable Object list read limit exceeded");
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit);
      return new Map(entries);
    },
    async transaction(callback) {
      const run = tail.then(() => callback(storage));
      tail = run.catch(() => {});
      return run;
    },
  };
  return { storage };
}

test("legacy browser and one-time login links are no longer exposed", async () => {
  for (const path of ["/connect/opaque-token-value", "/connect/exchange", "/connect/api"]) {
    const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev" + path, {
      method: path.endsWith("/exchange") || path.endsWith("/api") ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: path.endsWith("/exchange") || path.endsWith("/api") ? "{}" : undefined,
    }));
    assert.equal(response.status, 404);
  }
});

test("temporary auth state store accepts encrypted short-lived payloads only", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const state = createDurableObjectState();
  const store = new ConnectionLinkStore(state);
  const encrypted = { iv: Array(12).fill(7), ciphertext: Array(32).fill(9), expiresAt: Date.now() + 120000 };
  const saved = await store.fetch(new Request("https://do.internal/auth-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 500123, action: "set", state: encrypted }),
  }));
  assert.equal(saved.status, 200);
  const persisted = (await state.storage.list({ prefix: "telegram-auth-state:" })).get("telegram-auth-state:500123");
  assert.deepEqual(persisted, encrypted);
  const plaintext = await store.fetch(new Request("https://do.internal/auth-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 500123, action: "set", state: { stage: "code", code: "12345", expiresAt: Date.now() + 120000 } }),
  }));
  assert.equal(plaintext.status, 400);
});




test("owner role is assigned only to the configured numeric Telegram ID", () => {
  assert.equal(resolveRole(1001, "1001", "MEMBER", "active"), "OWNER");
  assert.equal(resolveRole(1002, "1001", "MEMBER", "active"), "MEMBER");
  assert.equal(resolveRole(1001, "1002", "MEMBER", "active"), "MEMBER");
});

test("blocked users cannot enter even if their stored role says MEMBER", () => {
  assert.equal(resolveRole(1002, "1001", "MEMBER", "blocked"), "BLOCKED");
});

test("member menu exposes only personal controls and keeps account actions in its submenu", () => {
  const callbacks = buildRoleMenu("MEMBER").inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("account:open"));
  assert.ok(callbacks.includes("catch:open"));
  assert.ok(!callbacks.includes("owner:members"));
  assert.ok(!callbacks.includes("owner:settings"));
  assert.ok(!callbacks.includes("owner:broadcast"));
});

test("owner menu includes global monitoring and member administration", () => {
  const callbacks = buildRoleMenu("OWNER").inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("owner:members"));
  assert.ok(callbacks.includes("owner:stats"));
  assert.ok(callbacks.includes("owner:settings"));
  assert.ok(callbacks.includes("owner:broadcast"));
});


test("user registry creates MEMBER records and reserves OWNER for the configured ID", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const post = (path, payload) => store.fetch(new Request("https://do.internal" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  const member = await post("/register", { telegramUserId: 2002, ownerTelegramId: "1001" });
  const owner = await post("/register", { telegramUserId: 1001, ownerTelegramId: "1001" });
  assert.equal((await member.json()).role, "MEMBER");
  assert.equal((await owner.json()).role, "OWNER");
  const fetched = await post("/user", { telegramUserId: 2002 });
  assert.equal((await fetched.json()).user.status, "active");
});

test("blocked member remains blocked on /start registration", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const post = (path, payload) => store.fetch(new Request("https://do.internal" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  await post("/register", { telegramUserId: 2002, ownerTelegramId: "1001" });
  await post("/manage-user", { telegramUserId: 2002, action: "block" });
  const restarted = await post("/register", { telegramUserId: 2002, ownerTelegramId: "1001" });
  assert.equal((await restarted.json()).status, "blocked");
});

test("member cannot invoke owner-only callbacks through the webhook", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const post = (path, payload) => store.fetch(new Request("https://do.internal" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  await post("/register", { telegramUserId: 2002, ownerTelegramId: "1001" });
  const calls = [];
  const env = {
    KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    OWNER_TELEGRAM_ID: "1001",
    CONNECT_LINKS: binding,
    FETCH: async (url, init) => {
      calls.push({ method: url.split("/").pop(), payload: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    },
  };
  const update = {
    update_id: 88,
    callback_query: {
      id: "callback-88", from: { id: 2002 },
      message: { message_id: 9, chat: { id: 2002, type: "private" } },
      data: "owner:stats",
    },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
    body: JSON.stringify(update),
  }), env);
  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery" && call.payload.show_alert === true));
  assert.ok(!calls.some((call) => call.method === "editMessageText"));
});


test("owner broadcast collects a draft, previews it, and sends only to active members after confirmation", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const post = (path, payload) => store.fetch(new Request("https://do.internal" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  await post("/register", { telegramUserId: 1001, ownerTelegramId: "1001" });
  await post("/register", { telegramUserId: 2001, ownerTelegramId: "1001" });
  await post("/register", { telegramUserId: 2002, ownerTelegramId: "1001" });
  await post("/manage-user", { telegramUserId: 2002, action: "block" });
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const calls = [];
  const env = {
    KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    OWNER_TELEGRAM_ID: "1001",
    CONNECT_LINKS: binding,
    FETCH: async (url, init) => {
      const method = url.split("/").pop();
      const payload = JSON.parse(init.body);
      calls.push({ method, payload });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const webhook = (update) => worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
    body: JSON.stringify(update),
  }), env);
  const callback = (id, data, messageId) => ({
    update_id: id,
    callback_query: { id: "callback-" + id, from: { id: 1001 }, message: { message_id: messageId, chat: { id: 1001, type: "private" } }, data },
  });
  assert.equal((await webhook(callback(301, "owner:broadcast", 1))).status, 200);
  assert.ok(calls.some((c) => c.method === "editMessageText" && /متن پیام/.test(c.payload.text)));

  calls.length = 0;
  assert.equal((await webhook({ update_id: 302, message: { message_id: 2, from: { id: 1001 }, chat: { id: 1001, type: "private" }, text: "سلام اعضای KageCatch" } })).status, 200);
  const preview = calls.find((c) => c.method === "sendMessage");
  assert.match(preview.payload.text, /سلام اعضای KageCatch/);
  assert.ok(preview.payload.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "owner:broadcast:confirm"));

  calls.length = 0;
  assert.equal((await webhook(callback(303, "owner:broadcast:confirm", 3))).status, 200);
  const deliveries = calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id !== 1001);
  assert.deepEqual(deliveries.map((c) => c.payload.chat_id), [2001]);
  assert.equal(deliveries[0].payload.text, "سلام اعضای KageCatch");
  assert.ok(calls.some((c) => c.method === "editMessageText" && c.payload.chat_id === 1001 && /ارسال همگانی تمام شد/.test(c.payload.text)));
});

test("broadcast draft is available only to the owner and supports cancellation", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const post = (path, payload) => store.fetch(new Request("https://do.internal" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  await post("/register", { telegramUserId: 1001, ownerTelegramId: "1001" });
  const started = await post("/broadcast", { ownerTelegramId: 1001, action: "begin" });
  assert.equal((await started.json()).status, "awaiting_text");
  const saved = await post("/broadcast", { ownerTelegramId: 1001, action: "save", text: "test" });
  assert.equal((await saved.json()).status, "awaiting_confirmation");
  const cancelled = await post("/broadcast", { ownerTelegramId: 1001, action: "clear" });
  assert.equal((await cancelled.json()).status, "cleared");
  const current = await post("/broadcast", { ownerTelegramId: 1001, action: "get" });
  assert.equal((await current.json()).draft, null);
});

test("broadcast rejects empty or oversized text", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const post = (payload) => store.fetch(new Request("https://do.internal/broadcast", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  await post({ ownerTelegramId: 1001, action: "begin" });
  assert.equal((await post({ ownerTelegramId: 1001, action: "save", text: "   " })).status, 400);
  assert.equal((await post({ ownerTelegramId: 1001, action: "save", text: "x".repeat(4097) })).status, 400);
});


test("Telegram menus stay native and do not redirect members into the Mini App", () => {
  for (const role of ["MEMBER", "OWNER"]) {
    const buttons = buildRoleMenu(role).inline_keyboard.flat();
    assert.equal(buttons.some((button) => button.web_app), false);
  }
});






import { createHash, createHmac } from "node:crypto";











// Mini App authentication regression coverage.















test("health distinguishes a reachable but unconfigured Python Core from an unreachable Core", async () => {
  const calls = [];
  const env = {
    KAGECATCH_DB: {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return { all: async () => ({ results: [
            { name: "d1_migrations" },
            { name: "telegram_bot_safety" },
            { name: "telegram_bot_chat_pacing" },
            { name: "telegram_bot_chat_circuit_breaker" },
            { name: "panel_requests" },
          ] }) };
        }
        if (sql.includes("d1_migrations")) {
          return { all: async () => ({ results: [
            { name: "0001_telegram_sessions.sql" },
            { name: "0002_telegram_auth_challenges.sql" },
            { name: "0003_manual_review_items.sql" },
            { name: "0004_panel_requests.sql" },
            { name: "0006_manual_review_spawn_context.sql" },
          ] }) };
        }
        throw new Error("unexpected health query");
      },
    }, TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    CORE_API_URL: "https://core.example.test",
    CORE_API_SECRET: "kagecatch-core-test-secret-32-bytes",
    FETCH: async (url, init) => {
      calls.push(url);
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "https://kagecatch-control.ahora-project.workers.dev/webhook", pending_update_count: 0, last_error_message: "Wrong response from the webhook: 502 Bad Gateway", last_error_date: 1794572719 } }), { status: 200 });
      }
      if (url.endsWith("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "KageCatchBot", first_name: "KageCatch" } }), { status: 200 });
      }
      assert.equal(url, "https://core.example.test/v1/health");
      return new Response(JSON.stringify({ service: "KageCatch Core", status: "degraded", execution_configured: false }), { status: 503 });
    },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/health"), env);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, "webhook_ready");
  assert.equal(health.python_core, "degraded");
  assert.equal(health.last_telegram_error_at, new Date(1794572719 * 1000).toISOString());
  assert.equal(health.d1_storage, "ready");
  assert.equal(health.d1_required_tables, 3);
  assert.deepEqual(health.d1_tables, ["d1_migrations", "telegram_bot_safety", "telegram_bot_chat_pacing", "telegram_bot_chat_circuit_breaker", "panel_requests"]);
  assert.equal(health.d1_migration_count, 5);
  assert.equal(health.d1_latest_migration, "0006_manual_review_spawn_context.sql");
  assert.deepEqual(health.d1_migration_names, [
    "0001_telegram_sessions.sql",
    "0002_telegram_auth_challenges.sql",
    "0003_manual_review_items.sql",
    "0004_panel_requests.sql",
    "0006_manual_review_spawn_context.sql",
  ]);
  assert.equal(calls.length, 3);
});




test("Telegram member menu exposes compact Catch and settings controls with no Mini App", () => {
  const menu = buildRoleMenu("MEMBER");
  const buttons = menu.inline_keyboard.flat();
  const callbacks = buttons.map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("catch:open"));
  assert.ok(callbacks.includes("settings:open"));
  assert.equal(buttons.some((button) => button.web_app), false);
  assert.ok(resolveCallback("catch:open").keyboard.inline_keyboard.flat().some((button) => button.callback_data === "bots:open"));
});

test("Telegram bot menus explain Catch and target bot readiness without claiming live execution", () => {
  assert.match(resolveCallback("catch:open").text, /هنوز آمادهٔ شکار واقعی نیستیم/);
  const bots = resolveCallback("bots:open");
  assert.match(bots.text, /HentaCatcherBot/);
  assert.match(bots.text, /Character_Catcher_Bot/);
  assert.match(bots.text, /SenpaiCatcherBot/);
  assert.match(bots.text, /هنوز تست واقعی نگرفتیم/);
});

test("settings callback is reachable and clearly separates unavailable controls", () => {
  const settings = resolveCallback("settings:open");
  assert.match(settings.text, /⚙️ تنظیمات/);
  assert.match(settings.text, /بعضی تنظیمات هنوز آماده نیستن/);
});

test("/start opens the compact native role menu directly", () => {
  const start = commandReply("/start");
  const callbacks = start.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("catch:open"));
  assert.ok(callbacks.includes("account:open"));
  assert.equal(start.reply_markup.inline_keyboard.length, 2);
});





async function makeSignedSessionStoreRequest(method, userId, payload, secret, nonce = crypto.randomUUID().replaceAll("-", ""), namespace = "session-store") {
  const path = "/internal/" + namespace + "/" + userId;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signingText = [timestamp, nonce, method, path, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingText))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://kagecatch-control.ahora-project.workers.dev" + path, {
    method,
    headers: {
      "X-KageCatch-Timestamp": timestamp,
      "X-KageCatch-Nonce": nonce,
      "X-KageCatch-Signature": signature,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
}

function createFakeD1SessionDatabase() {
  const rows = new Map();
  const challengeRows = new Map();
  return {
    rows,
    challengeRows,
    prepare(sql) {
      return {
        async all() {
          if (sql.startsWith("SELECT user_id FROM telegram_sessions")) {
            return { results: [...rows.keys()].sort().map((user_id) => ({ user_id })) };
          }
          throw new Error("unexpected D1 statement");
        },
        bind(...values) {
          return {
            async run() {
              if (sql.startsWith("INSERT INTO telegram_sessions")) {
                rows.set(values[0], values[1]);
                return { success: true };
              }
              if (sql.startsWith("DELETE FROM telegram_sessions")) {
                rows.delete(values[0]);
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO telegram_auth_challenges")) {
                challengeRows.set(values[0], values[1]);
                return { success: true };
              }
              if (sql.startsWith("DELETE FROM telegram_auth_challenges")) {
                challengeRows.delete(values[0]);
                return { success: true };
              }
              throw new Error("unexpected D1 statement");
            },
            async first() {
              if (sql.startsWith("SELECT encrypted_session FROM telegram_sessions")) {
                const value = rows.get(values[0]);
                return value === undefined ? null : { encrypted_session: value };
              }
              if (sql.startsWith("SELECT encrypted_payload FROM telegram_auth_challenges")) {
                const value = challengeRows.get(values[0]);
                return value === undefined ? null : { encrypted_payload: value };
              }
              throw new Error("unexpected D1 statement");
            },
            async all() {
              if (sql.startsWith("SELECT user_id FROM telegram_sessions")) {
                return { results: [...rows.keys()].sort().map((user_id) => ({ user_id })) };
              }
              throw new Error("unexpected D1 statement");
            },
          };
        },
      };
    },
  };
}

test("signed internal session store persists, retrieves, and deletes encrypted ciphertext through D1", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const state = createDurableObjectState();
  const nonceStore = new ConnectionLinkStore(state);
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => nonceStore.fetch(new Request(input, init)) }) };
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const DB = createFakeD1SessionDatabase();
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: DB };
  const put = await worker.fetch(await makeSignedSessionStoreRequest("PUT", "7135051954", { ciphertext: "ZW5jcnlwdGVkLWJsb2I=" }, secret), env);
  assert.equal(put.status, 200);
  assert.equal(DB.rows.get("7135051954"), "ZW5jcnlwdGVkLWJsb2I=");
  const get = await worker.fetch(await makeSignedSessionStoreRequest("GET", "7135051954", undefined, secret), env);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { ciphertext: "ZW5jcnlwdGVkLWJsb2I=" });
  const remove = await worker.fetch(await makeSignedSessionStoreRequest("DELETE", "7135051954", undefined, secret), env);
  assert.equal(remove.status, 200);
  assert.equal(DB.rows.has("7135051954"), false);
});

test("signed auth challenge store persists, retrieves, and deletes encrypted payload separately", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const nonceStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => nonceStore.fetch(new Request(input, init)) }) };
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const DB = createFakeD1SessionDatabase();
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: DB };
  const ciphertext = "ZW5jcnlwdGVkLWF1dGgtY2hhbGxlbmdl";
  const put = await worker.fetch(await makeSignedSessionStoreRequest("PUT", "7135051954", { ciphertext }, secret, undefined, "auth-challenge"), env);
  assert.equal(put.status, 200);
  assert.equal(DB.challengeRows.get("7135051954"), ciphertext);
  assert.equal(DB.rows.has("7135051954"), false);
  const get = await worker.fetch(await makeSignedSessionStoreRequest("GET", "7135051954", undefined, secret, undefined, "auth-challenge"), env);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { ciphertext });
  const remove = await worker.fetch(await makeSignedSessionStoreRequest("DELETE", "7135051954", undefined, secret, undefined, "auth-challenge"), env);
  assert.equal(remove.status, 200);
  assert.equal(DB.challengeRows.has("7135051954"), false);
});

test("signed internal session index lists only user IDs and never session ciphertext", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const nonceStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => nonceStore.fetch(new Request(input, init)) }) };
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const DB = createFakeD1SessionDatabase();
  DB.rows.set("2002", "ciphertext-two");
  DB.rows.set("1001", "ciphertext-one");
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: DB };
  const response = await worker.fetch(
    await makeSignedSessionStoreRequest("GET", "users", undefined, secret),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { users: ["1001", "2002"] });
});

test("internal session store rejects unsigned requests and replays", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const nonceStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => nonceStore.fetch(new Request(input, init)) }) };
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: createFakeD1SessionDatabase() };
  const unsigned = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/internal/session-store/7135051954", { method: "GET" }), env);
  assert.equal(unsigned.status, 401);
  const request = await makeSignedSessionStoreRequest("GET", "7135051954", undefined, secret, "b".repeat(32));
  assert.equal((await worker.fetch(request, env)).status, 404);
  const replay = await makeSignedSessionStoreRequest("GET", "7135051954", undefined, secret, "b".repeat(32));
  assert.equal((await worker.fetch(replay, env)).status, 409);
});



test("internal session store retains a hard 16 KiB request body ceiling", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const nonceStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => nonceStore.fetch(new Request(input, init)) }) };
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: createFakeD1SessionDatabase() };
  const ciphertext = "A".repeat(17000);
  const request = await makeSignedSessionStoreRequest("PUT", "7135051954", { ciphertext }, secret);
  const requestBody = await request.clone().arrayBuffer();
  assert.ok(requestBody.byteLength > 16 * 1024);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
});

test("internal session store accepts Fernet-sized encrypted session payloads", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const nonceStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => nonceStore.fetch(new Request(input, init)) }) };
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const DB = createFakeD1SessionDatabase();
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: DB };
  // Fernet + Base64 for the Core's bounded StringSession can exceed 8 KiB.
  const ciphertext = "A".repeat(12000);
  const request = await makeSignedSessionStoreRequest("PUT", "7135051954", { ciphertext }, secret);
  const requestBody = await request.clone().arrayBuffer();
  assert.ok(requestBody.byteLength > 8192 && requestBody.byteLength <= 16384);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(DB.rows.get("7135051954"), ciphertext);
});

test("internal auth challenge store accepts Fernet-sized encrypted checkpoint payloads", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const nonceStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => nonceStore.fetch(new Request(input, init)) }) };
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const DB = createFakeD1SessionDatabase();
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: DB };
  const ciphertext = "A".repeat(12000);
  const request = await makeSignedSessionStoreRequest("PUT", "7135051954", { ciphertext }, secret, undefined, "auth-challenge");
  const requestBody = await request.clone().arrayBuffer();
  assert.ok(requestBody.byteLength > 8192 && requestBody.byteLength <= 16384);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(DB.challengeRows.get("7135051954"), ciphertext);
});

test("internal session store refuses invalid user identifiers and oversized payloads", async () => {
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const invalid = await worker.fetch(await makeSignedSessionStoreRequest("GET", "../100", undefined, secret), { CORE_API_SECRET: secret });
  assert.equal(invalid.status, 404);
});





test("owner menu exposes a dedicated invite-management section", () => {
  const callbacks = buildRoleMenu("OWNER").inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("owner:invites"));

});

test("invite records are owner-created, expiring, revocable, and limited by use count", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const create = () => store.fetch(new Request("https://do.internal/invite/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxUses: 2, ttlSeconds: 86400 }),
  }));
  const created = await create();
  assert.equal(created.status, 201);
  const invite = await created.json();
  assert.match(invite.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(invite.maxUses, 2);
  assert.equal(invite.expiresIn, 86400);
  const consume = (telegramUserId) => store.fetch(new Request("https://do.internal/invite/consume", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: invite.token, telegramUserId }),
  }));
  const first = await consume(100001);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).user.status, "active");
  const second = await consume(100002);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).user.status, "active");
  assert.equal((await consume(100003)).status, 410);
});

test("invite store rejects invalid tokens, duplicate member redemption, and supports revocation", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/invite/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxUses: 1, ttlSeconds: 3600 }),
  }));
  const { token, id } = await created.json();
  const consume = (telegramUserId, value = token) => store.fetch(new Request("https://do.internal/invite/consume", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: value, telegramUserId }),
  }));
  assert.equal((await consume(200001, "invalid-token")).status, 400);
  assert.equal((await consume(200001)).status, 200);
  assert.equal((await consume(200001)).status, 200);
  const revoked = await store.fetch(new Request("https://do.internal/invite/revoke", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }));
  assert.equal(revoked.status, 200);
  const second = await store.fetch(new Request("https://do.internal/invite/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxUses: 10, ttlSeconds: 3600 }),
  }));
  const secondInvite = await second.json();
  assert.equal((await store.fetch(new Request("https://do.internal/invite/revoke", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: secondInvite.id }),
  }))).status, 200);
  const secondToken = secondInvite.token;
  assert.equal((await consume(200002, secondToken)).status, 410);
});

test("new Telegram users cannot self-register without a valid invitation", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const calls = [];
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_WEBHOOK_SECRET: "hook-secret", KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "bot-token",
    FETCH: async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); } };
  const denied = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 300001, message: { chat: { id: 300001, type: "private" }, from: { id: 300001 }, text: "/start" } }),
  }), env);
  assert.equal(denied.status, 200);
  assert.match(calls[0].text, /لینک دعوت نیاز داری/);
  const user = await store.fetch(new Request("https://do.internal/user", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 300001 }) }));
  assert.equal((await user.json()).user, null);
});

test("valid invite deep link grants MEMBER access exactly once and remains usable for its configured capacity", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const create = await store.fetch(new Request("https://do.internal/invite/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxUses: 1, ttlSeconds: 86400 }) }));
  const invite = await create.json();
  const redeemed = await store.fetch(new Request("https://do.internal/invite/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite.token, telegramUserId: 400001 }) }));
  assert.equal(redeemed.status, 200);
  assert.equal((await redeemed.json()).user.role, "MEMBER");
  const duplicate = await store.fetch(new Request("https://do.internal/invite/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite.token, telegramUserId: 400001 }) }));
  assert.equal(duplicate.status, 200);
  const otherUser = await store.fetch(new Request("https://do.internal/invite/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite.token, telegramUserId: 400002 }) }));
  assert.equal(otherUser.status, 410);
});


test("Owner can create an invitation from the private owner menu", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 999001, ownerTelegramId: "999001" }) }));
  const calls = [];
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "bot-token",
    FETCH: async (url, init) => { calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); } };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 900001, callback_query: { id: "cb1", data: "owner:invite:create:1", from: { id: 999001 }, message: { message_id: 5, chat: { id: 999001, type: "private" } } } }),
  }), { ...env, TELEGRAM_WEBHOOK_SECRET: "hook-secret" });
  assert.equal(response.status, 200);
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.match(edit.payload.text, /لینک دعوت ساخته شد/);
  assert.match(edit.payload.reply_markup.inline_keyboard[0][0].url, /start=inv_/);
  const listing = await store.fetch(new Request("https://do.internal/invite/list", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal((await listing.json()).invites.length, 1);
});

test("a valid Telegram invite deep link on /start creates a member record", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const created = await store.fetch(new Request("https://do.internal/invite/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxUses: 1, ttlSeconds: 86400 }) }));
  const invite = await created.json();
  const calls = [];
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_WEBHOOK_SECRET: "hook-secret", KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "bot-token",
    FETCH: async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); } };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 400001, message: { chat: { id: 400001, type: "private" }, from: { id: 400001 }, text: "/start inv_" + invite.token } }),
  }), env);
  assert.equal(response.status, 200);
  assert.match(calls[0].text, /دعوتت تأیید شد/);
  const user = await store.fetch(new Request("https://do.internal/user", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 400001 }) }));
  assert.equal((await user.json()).user.role, "MEMBER");
});


test("unknown Telegram identities are denied until an Owner invitation is redeemed", () => {
  assert.equal(resolveRole(7654321, "999001"), "DENIED");
});


test("Owner invite screen renders real line breaks and keeps creation and back buttons visible", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 999001, ownerTelegramId: "999001" }) }));
  const calls = [];
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    FETCH: async (url, init) => { calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); } };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 900002, callback_query: { id: "cb2", data: "owner:invites", from: { id: 999001 }, message: { message_id: 6, chat: { id: 999001, type: "private" } } } }),
  }), env);
  assert.equal(response.status, 200);
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.doesNotMatch(edit.payload.text, /\\n/);
  const rows = edit.payload.reply_markup.inline_keyboard;
  assert.ok(rows.flat().some((button) => button.callback_data === "owner:invite:create:1"));
  assert.ok(rows.flat().some((button) => button.callback_data === "owner:invite:create:10"));
  assert.ok(rows.flat().some((button) => button.callback_data === "home:admin"));
});

test("Owner activity registry stores only action metadata and updates last-seen time", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 500001, ownerTelegramId: "999001" }) }));
  const recorded = await store.fetch(new Request("https://do.internal/activity/record", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 500001, action: "account:list" }),
  }));
  assert.equal(recorded.status, 200);
  const users = await store.fetch(new Request("https://do.internal/users", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  const user = (await users.json()).users.find((item) => item.telegramUserId === 500001);
  assert.equal(user.lastAction, "account:list");
  assert.ok(Number.isFinite(user.lastSeenAt));
  assert.equal(Object.hasOwn(user, "messageText"), false);
});


test("Owner menu exposes user monitoring and monitor screen distinguishes online from saved sessions", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 999001, ownerTelegramId: "999001" }) }));
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 500002, ownerTelegramId: "999001" }) }));
  await store.fetch(new Request("https://do.internal/activity/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 500002, action: "account:list", firstName: "TestUser" }) }));
  const calls = [];
  const sequence = [];
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    CORE_API_URL: "https://core.example", CORE_API_SECRET: "a".repeat(40),
    FETCH: async (url, init) => {
      if (String(url).endsWith("/v1/accounts/500002")) { sequence.push("core"); return new Response(JSON.stringify({ status: "authorized", session_saved: true, connected: false }), { status: 200 }); }
      const method = String(url).split("/").pop();
      if (method === "answerCallbackQuery") sequence.push("ack");
      calls.push({ method, payload: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    } };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 900003, callback_query: { id: "cb3", data: "owner:monitor", from: { id: 999001 }, message: { message_id: 7, chat: { id: 999001, type: "private" } } } }),
  }), env);
  assert.equal(response.status, 200);
  assert.ok(sequence.indexOf("ack") >= 0 && sequence.indexOf("ack") < sequence.indexOf("core"), "callback must be acknowledged before slow Core status lookups");
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.match(edit.payload.text, /نشست مجاز ذخیره است؛ کلاینت اجرا نیست/);
  assert.match(edit.payload.text, /TestUser/);
  assert.ok(edit.payload.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "owner:monitor:user:500002"));
});


async function makeSignedManualReviewRequest(payload, secret, nonce = crypto.randomUUID().replaceAll("-", "")) {
  const path = "/internal/manual-review";
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signingText = [timestamp, nonce, "POST", path, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingText))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://kagecatch-control.ahora-project.workers.dev" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-KageCatch-Timestamp": timestamp,
      "X-KageCatch-Nonce": nonce,
      "X-KageCatch-Signature": signature,
    },
    body,
  });
}

function createFakeManualReviewDatabase() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              if (sql.startsWith("INSERT OR IGNORE INTO manual_review_items")) {
                const [review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, quota_user_id] = values;
                if (rows.has(review_id)) return { meta: { changes: 0 } };
                if (quota_user_id && [...rows.values()].filter((row) => row.user_id === quota_user_id && row.status === "pending" && row.expires_at > values[8]).length >= 100) return { meta: { changes: 0 } };
                rows.set(review_id, {
                  review_id, user_id, spawn_id, anime_name, candidates_json,
                  created_at, expires_at, status: "pending", selected_character: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("INSERT INTO manual_review_items")) {
                const [review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, quota_user_id] = values;
                if (rows.has(review_id)) throw new Error("duplicate review id");
                if (quota_user_id && [...rows.values()].filter((row) => row.user_id === quota_user_id && row.status === "pending" && row.expires_at > values[8]).length >= 100) return { meta: { changes: 0 } };
                rows.set(review_id, {
                  review_id, user_id, spawn_id, anime_name, candidates_json,
                  created_at, expires_at, status: "pending", selected_character: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE manual_review_items SET status = 'expired' WHERE status")) {
                let changes = 0;
                for (const row of rows.values()) {
                  if (row.status === "pending" && row.expires_at <= values[0]) { row.status = "expired"; changes += 1; }
                }
                return { meta: { changes } };
              }
              if (sql.startsWith("UPDATE manual_review_items SET status = 'expired' WHERE user_id")) {
                let changes = 0;
                for (const row of rows.values()) {
                  if (row.user_id === values[0] && row.status === "pending" && row.expires_at <= values[1]) { row.status = "expired"; changes += 1; }
                }
                return { meta: { changes } };
              }
              if (sql.startsWith("UPDATE manual_review_items SET status = 'expired' WHERE review_id")) {
                const row = rows.get(values[0]);
                if (row && row.user_id === values[1] && row.status === "pending") { row.status = "expired"; return { meta: { changes: 1 } }; }
                return { meta: { changes: 0 } };
              }
              if (sql.startsWith("UPDATE manual_review_items SET status = ?")) {
                const [status, selected_character, review_id, user_id, now] = values;
                const row = rows.get(review_id);
                if (row && row.user_id === user_id && row.status === "pending" && row.expires_at > now) {
                  row.status = status; row.selected_character = selected_character;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              throw new Error("unexpected D1 run: " + sql);
            },
            async first() {
              if (sql.startsWith("SELECT review_id, user_id, spawn_id, anime_name, candidates_json FROM manual_review_items WHERE review_id = ?")) {
                const row = rows.get(values[0]);
                return row ? { ...row } : null;
              }
              if (sql.startsWith("SELECT review_id, user_id")) {
                const row = rows.get(values[0]);
                return row && row.user_id === values[1] ? { ...row } : null;
              }
              throw new Error("unexpected D1 first: " + sql);
            },
            async all() {
              if (sql.startsWith("SELECT review_id, user_id")) {
                return { results: [...rows.values()]
                  .filter((row) => row.user_id === values[0] && row.status === "pending")
                  .sort((a, b) => a.created_at.localeCompare(b.created_at))
                  .slice(0, 100)
                  .map((row) => ({ ...row })) };
              }
              throw new Error("unexpected D1 all: " + sql);
            },
          };
        },
      };
    },
  };
}

test("durable manual review endpoint creates, lists, and atomically approves only for the owning user", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const connectionStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = {
    idFromName: () => "connection-links-v1",
    get: () => ({ fetch: (input, init) => connectionStore.fetch(new Request(input, init)) }),
  };
  const db = createFakeManualReviewDatabase();
  const secret = "manual-review-core-secret-with-32-bytes";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: db };
  const item = {
    action: "create", review_id: "a".repeat(32), user_id: "12345",
    spawn_id: 77, anime_name: "KonoSuba", candidates: ["Megumin", "Aqua"],
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };

  const created = await worker.fetch(await makeSignedManualReviewRequest(item, secret), env);
  assert.equal(created.status, 201);
  const listed = await worker.fetch(await makeSignedManualReviewRequest({ action: "list", user_id: "12345" }, secret), env);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).items.length, 1);
  const hidden = await worker.fetch(await makeSignedManualReviewRequest({ action: "list", user_id: "99999" }, secret), env);
  assert.deepEqual(await hidden.json(), { items: [] });

  const approved = await worker.fetch(await makeSignedManualReviewRequest({
    action: "approve", user_id: "12345", review_id: "a".repeat(32), candidate_index: 1,
  }, secret), env);
  assert.equal(approved.status, 200);
  const result = await approved.json();
  assert.equal(result.item.status, "approved");
  assert.equal(result.item.selected_character, "Aqua");
  const secondApproval = await worker.fetch(await makeSignedManualReviewRequest({
    action: "approve", user_id: "12345", review_id: "a".repeat(32), candidate_index: 0,
  }, secret), env);
  assert.equal(secondApproval.status, 409);
});

test("durable manual review endpoint rejects invalid signatures and cross-user resolution", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const connectionStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = {
    idFromName: () => "connection-links-v1",
    get: () => ({ fetch: (input, init) => connectionStore.fetch(new Request(input, init)) }),
  };
  const db = createFakeManualReviewDatabase();
  const secret = "manual-review-core-secret-with-32-bytes";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: db };
  const item = {
    action: "create", review_id: "b".repeat(32), user_id: "12345",
    spawn_id: 77, anime_name: "KonoSuba", candidates: ["Megumin"],
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  await worker.fetch(await makeSignedManualReviewRequest(item, secret), env);
  const wrongOwner = await worker.fetch(await makeSignedManualReviewRequest({
    action: "reject", user_id: "99999", review_id: "b".repeat(32),
  }, secret), env);
  assert.equal(wrongOwner.status, 404);
  const unsigned = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/internal/manual-review", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "expire" }),
  }), env);
  assert.equal(unsigned.status, 401);
});

test("durable manual review endpoint atomically caps pending items at 100 per user", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const connectionStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => connectionStore.fetch(new Request(input, init)) }) };
  const db = createFakeManualReviewDatabase();
  const secret = "manual-review-core-secret-with-32-bytes";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: db };
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  for (let index = 0; index < 100; index += 1) {
    const response = await worker.fetch(await makeSignedManualReviewRequest({
      action: "create", review_id: index.toString(16).padStart(32, "0"),
      user_id: "quota-user", spawn_id: index, anime_name: "KonoSuba",
      candidates: ["Megumin"], created_at: createdAt, expires_at: expiresAt,
    }, secret), env);
    assert.equal(response.status, 201);
  }
  const overflow = await worker.fetch(await makeSignedManualReviewRequest({
    action: "create", review_id: "f".repeat(32), user_id: "quota-user",
    spawn_id: 101, anime_name: "KonoSuba", candidates: ["Aqua"],
    created_at: createdAt, expires_at: expiresAt,
  }, secret), env);
  assert.equal(overflow.status, 429);
  assert.deepEqual(await overflow.json(), { error: "pending_queue_limit_reached" });
  assert.equal(db.rows.size, 100);
});


test("webhook processing failures emit structured diagnostics without exposing error messages or secrets", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  await store.fetch(new Request("https://do.internal/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 999001, ownerTelegramId: "999001" }),
  }));
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const env = {
      CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001",
      KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
      FETCH: async () => { throw Object.assign(new Error("token=must-not-appear"), { status: 502 }); },
    };
    const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
      body: JSON.stringify({ update_id: 7654321, callback_query: {
        id: "cb-failure", data: "menu:main", from: { id: 999001 },
        message: { message_id: 12, chat: { id: 999001, type: "private" } },
      } }),
    }), env);
    assert.equal(response.status, 502);
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0]);
    assert.equal(event.event, "telegram_webhook_processing_failed");
    assert.equal(event.stage, "callback");
    assert.equal(event.update_id, 7654321);
    assert.equal(event.upstream_status, 502);
    assert.equal(event.error_name, "Error");
    assert.doesNotMatch(logs[0], /must-not-appear|test-token|hook-secret/);
  } finally {
    console.error = originalError;
  }
});


test("scheduled keepalive sends a lightweight GET to the Render Core liveness endpoint", async () => {
  let captured;
  const result = await worker.scheduled(
    { cron: "*/10 * * * *", scheduledTime: Date.now() },
    {
      FETCH: async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({ service: "KageCatch Core", status: "alive" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(captured.url, "https://kagecatch-core-preview.onrender.com/healthz");
  assert.equal(captured.init.method, "GET");
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
});

test("scheduled keepalive reports Render failures without crashing the Cron invocation", async () => {
  const result = await worker.scheduled(
    { cron: "*/10 * * * *", scheduledTime: Date.now() },
    { FETCH: async () => new Response("unavailable", { status: 503 }) },
  );
  assert.equal(result.status, 503);
  assert.equal(result.ok, false);
});


test("scheduled keepalive never drains the panel queue or depends on D1", async () => {
  let keepaliveCalls = 0;
  let databaseCalls = 0;
  const result = await worker.scheduled(
    { cron: "*/10 * * * *", scheduledTime: Date.now() },
    {
      FETCH: async () => {
        keepaliveCalls += 1;
        return new Response("alive", { status: 200 });
      },
      KAGECATCH_DB: {
        prepare() {
          databaseCalls += 1;
          throw new Error("scheduled keepalive must not touch the panel queue");
        },
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(keepaliveCalls, 1);
  assert.equal(databaseCalls, 0);
});


test("manual webhook setup endpoint requires the Core admin secret and repairs then verifies Telegram webhook", async () => {
  const secret = "core-admin-secret-with-at-least-32-bytes";
  let webhookUrl = "";
  const calls = [];
  const env = {
    CORE_API_SECRET: secret,
    KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123",
    FETCH: async (url, init) => {
      const method = String(url).split("/").pop();
      const payload = JSON.parse(init.body);
      calls.push({ method, payload });
      if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: webhookUrl } }), { status: 200 });
      if (method === "setWebhook") { webhookUrl = payload.url; return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }); }
      throw new Error("unexpected Telegram method");
    },
  };
  const url = "https://kagecatch-control.ahora-project.workers.dev/admin/setup-webhook";
  const denied = await worker.fetch(new Request(url, { method: "POST" }), env);
  assert.equal(denied.status, 401);
  const response = await worker.fetch(new Request(url, {
    method: "POST", headers: { authorization: "Bearer " + secret },
  }), env);
  assert.equal(response.status, 200);
  const responseBody = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(responseBody), { status: "configured", verified: true });
  assert.doesNotMatch(responseBody, /test-bot-token|test_webhook_secret_123|core-admin-secret/);
  assert.equal(webhookUrl, "https://kagecatch-control.ahora-project.workers.dev/webhook");
  assert.deepEqual(calls.map((call) => call.method), ["getWebhookInfo", "setWebhook", "getWebhookInfo"]);
  assert.equal(calls[1].payload.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
  assert.equal(calls[1].payload.drop_pending_updates, false);
});

test("manual webhook setup endpoint rejects wrong methods without exposing configured secrets", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/admin/setup-webhook", {
    method: "GET",
  }), {
    CORE_API_SECRET: "core-admin-secret-with-at-least-32-bytes",
    KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123",
  });
  assert.equal(response.status, 405);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: "method_not_allowed" });
  assert.doesNotMatch(body, /test-bot-token|test_webhook_secret_123|core-admin-secret/);
});

test("manual webhook setup derives the webhook host from the incoming Worker origin", async () => {
  const secret = "core-admin-secret-with-at-least-32-bytes";
  let webhookUrl = "";
  const env = {
    CORE_API_SECRET: secret,
    KAGECATCH_DB: createTelegramSafetyDb(), TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123",
    FETCH: async (url, init) => {
      const method = String(url).split("/").pop();
      const payload = JSON.parse(init.body);
      if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: webhookUrl } }));
      if (method === "setWebhook") {
        webhookUrl = payload.url;
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      throw new Error("unexpected Telegram method");
    },
  };
  const response = await worker.fetch(new Request("https://custom-worker.example/admin/setup-webhook", {
    method: "POST",
    headers: { authorization: "Bearer " + secret },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(webhookUrl, "https://custom-worker.example/webhook");
});



test("native account login completes in private Telegram chat with optional 2FA and direct no-2FA success", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const state = createDurableObjectState();
  const store = new ConnectionLinkStore(state);
  const binding = {
    idFromName: () => "connection-links-v1",
    get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }),
  };
  for (const telegramUserId of [500123, 500124]) {
    await store.fetch(new Request("https://do.internal/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegramUserId, ownerTelegramId: "999001" }),
    }));
  }

  const telegramCalls = [];
  const coreCalls = [];
  const env = {
    KAGECATCH_DB: createTelegramSafetyDb(),
    CONNECT_LINKS: binding,
    OWNER_TELEGRAM_ID: "999001",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    CORE_API_URL: "https://core.example",
    CORE_API_SECRET: "core-secret-with-at-least-32-characters",
    FETCH: async (url, init) => {
      const target = String(url);
      if (target.startsWith("https://api.telegram.org/")) {
        const method = target.split("/").pop();
        const payload = JSON.parse(init.body);
        telegramCalls.push({ method, payload });
        return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 77 } : {} }), { status: 200 });
      }
      const payload = init.body ? JSON.parse(init.body) : null;
      coreCalls.push({ url: target, payload });
      if (target.endsWith("/v1/accounts/500123/connect") || target.endsWith("/v1/accounts/500124/connect")) return new Response(JSON.stringify({ status: "code_sent" }), { status: 200 });
      if (target.endsWith("/v1/accounts/500123/connect/code")) return new Response(JSON.stringify({ status: "password_required" }), { status: 200 });
      if (target.endsWith("/v1/accounts/500124/connect/code")) return new Response(JSON.stringify({ status: "connected" }), { status: 200 });
      if (target.endsWith("/v1/accounts/500123/connect/password")) return new Response(JSON.stringify({ status: "connected" }), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected_core_route" }), { status: 404 });
    },
  };

  const webhook = async (update_id, update) => worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id, ...update }),
  }), env);

  const callback = (id, data, messageId = 1, telegramUserId = 500123) => ({
    callback_query: {
      id: "cb-" + id,
      data,
      from: { id: telegramUserId },
      message: { message_id: messageId, chat: { id: telegramUserId, type: "private" } },
    },
  });
  const message = (id, text, telegramUserId = 500123) => ({
    message: {
      message_id: id,
      text,
      chat: { id: telegramUserId, type: "private" },
      from: { id: telegramUserId, first_name: "Member" },
    },
  });

  assert.equal((await webhook(1, callback(1, "account:connect"))).status, 200);
  assert.equal((await webhook(2, message(2, "+989121234567"))).status, 200);

  const keypadMessage = telegramCalls.find((call) => call.method === "sendMessage" && call.payload.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === "auth:submit"));
  assert.ok(keypadMessage);
  // Malformed auth callbacks must not cancel or clear a valid login flow.
  assert.equal((await webhook(30, callback(30, "auth:unknown", 77))).status, 200);
  // A callback originating from another private chat must not act on that user's account.
  assert.equal((await webhook(31, {
    callback_query: {
      id: "cb-31",
      data: "auth:cancel",
      from: { id: 500124 },
      message: { message_id: 77, chat: { id: 500123, type: "private" } },
    },
  })).status, 200);
  assert.equal(coreCalls.some((call) => call.url.endsWith("/connect/cancel")), false);
  const keypadButtons = keypadMessage.payload.reply_markup.inline_keyboard.flat();
  assert.ok(keypadButtons.every((button) => !/[0-9]{4,}/.test(button.callback_data)));

  for (const [index, digit] of ["1", "2", "3", "4", "5"].entries()) {
    assert.equal((await webhook(3 + index, callback(3 + index, "auth:digit:" + digit, 77))).status, 200);
  }
  assert.equal((await webhook(8, callback(8, "auth:submit", 77))).status, 200);
  assert.equal((await webhook(9, message(9, "private-2fa-password"))).status, 200);

  const codeRequest = coreCalls.find((call) => call.url.endsWith("/connect/code"));
  const passwordRequest = coreCalls.find((call) => call.url.endsWith("/connect/password"));
  assert.deepEqual(codeRequest.payload, { code: "12345" });
  assert.deepEqual(passwordRequest.payload, { password: "private-2fa-password" });
  assert.ok(telegramCalls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 2));
  assert.ok(telegramCalls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 9));
  assert.ok(telegramCalls.some((call) => call.method === "sendMessage" && /با موفقیت متصل شد/.test(call.payload.text)));
  assert.ok(telegramCalls.every((call) => !JSON.stringify(call.payload).includes("12345")));
  assert.ok(telegramCalls.every((call) => !JSON.stringify(call.payload).includes("private-2fa-password")));

  const remaining = await store.fetch(new Request("https://do.internal/auth-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 500123, action: "get" }),
  }));
  assert.deepEqual(await remaining.json(), { state: null });

  assert.equal((await webhook(10, callback(10, "account:connect", 1, 500124))).status, 200);
  assert.equal((await webhook(11, message(11, "+989121234568", 500124))).status, 200);
  for (const [index, digit] of ["6", "5", "4", "3", "2"].entries()) {
    assert.equal((await webhook(12 + index, callback(12 + index, "auth:digit:" + digit, 77, 500124))).status, 200);
  }
  assert.equal((await webhook(17, callback(17, "auth:submit", 77, 500124))).status, 200);

  const directCodeRequest = coreCalls.find((call) => call.url.endsWith("/v1/accounts/500124/connect/code"));
  assert.deepEqual(directCodeRequest.payload, { code: "65432" });
  assert.equal(coreCalls.some((call) => call.url.endsWith("/v1/accounts/500124/connect/password")), false);
  const directUserMessages = telegramCalls.filter((call) => call.payload.chat_id === 500124);
  assert.ok(directUserMessages.some((call) => call.method === "editMessageText" && /با موفقیت متصل شد/.test(call.payload.text)));
  assert.equal(directUserMessages.some((call) => /رمز دومرحله‌ای/.test(call.payload.text)), false);
  const directRemaining = await store.fetch(new Request("https://do.internal/auth-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 500124, action: "get" }),
  }));
  assert.deepEqual(await directRemaining.json(), { state: null });
});

test("saved account statuses include connected and authorized only", () => {
  assert.equal(isSavedAccountStatus("connected"), true);
  assert.equal(isSavedAccountStatus("authorized"), true);
  assert.equal(isSavedAccountStatus("pending"), false);
});

test("one-time D1 migration endpoint is retired after schema initialization", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/admin/d1-migrations", { method: "POST" }), {});
  assert.equal(response.status, 404);
});

test("web dashboard, Mini App, browser login, and account proxy routes are retired", async () => {
  const base = "https://kagecatch-control.ahora-project.workers.dev";
  const removed = [
    ["/panel", "GET"],
    ["/connect/example-token-which-is-long-enough-to-be-valid-12345678901234567890", "GET"],
    ["/connect/exchange", "POST"],
    ["/connect/api", "POST"],
    ["/api/session", "POST"],
    ["/api/owner/safety/status", "POST"],
    ["/api/owner/safety/recover", "POST"],
    ["/api/account/status", "POST"],
    ["/api/account/connect", "POST"],
    ["/api/account/connect/code", "POST"],
    ["/api/account/connect/password", "POST"],
    ["/api/account/connect/status", "POST"],
    ["/api/account/connect/cancel", "POST"],
    ["/api/account/reconnect", "POST"],
    ["/api/account/disconnect", "POST"],
    ["/api/account/revoke", "POST"],
  ];
  for (const [path, method] of removed) {
    const response = await worker.fetch(new Request(base + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    }), {});
    assert.equal(response.status, 404, `${method} ${path} must be retired`);
  }
});

test("Owner bot menu keeps Telegram controls and contains no dashboard or Mini App entry", () => {
  const buttons = buildRoleMenu("OWNER").inline_keyboard.flat();
  const callbacks = buttons.map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("owner:members"));
  assert.ok(callbacks.includes("owner:invites"));
  assert.ok(callbacks.includes("owner:broadcast"));
  assert.ok(callbacks.includes("owner:emergency"));
  assert.ok(callbacks.includes("owner:safety"));
  assert.ok(!callbacks.includes("home:panel"));
  assert.ok(buttons.every((button) => !button.url && !button.web_app));
});

test("durable manual review create is idempotent and rejects conflicting reuse", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const connectionStore = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => connectionStore.fetch(new Request(input, init)) }) };
  const db = createFakeManualReviewDatabase();
  const secret = "manual-review-core-secret-with-32-bytes";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: db };
  const reviewId = "c".repeat(32);
  const item = {
    action: "create", review_id: reviewId, user_id: "12345",
    spawn_id: 77, anime_name: "KonoSuba", candidates: ["Megumin", "Aqua"],
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.equal((await worker.fetch(await makeSignedManualReviewRequest(item, secret), env)).status, 201);
  const retry = { ...item, created_at: new Date(Date.now() + 5_000).toISOString(), expires_at: new Date(Date.now() + 65_000).toISOString() };
  const replay = await worker.fetch(await makeSignedManualReviewRequest(retry, secret), env);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { status: "created", idempotent: true });
  const conflict = await worker.fetch(await makeSignedManualReviewRequest({ ...item, spawn_id: 78 }, secret), env);
  assert.equal(conflict.status, 409);
  assert.equal(db.rows.size, 1);
});

async function makeSignedJobQueueRequest(payload, secret, nonce = crypto.randomUUID().replaceAll("-", "")) {
  const path = "/internal/job-queue", body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), b => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode([timestamp, nonce, "POST", path, hash].join("\n")))), b => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://kagecatch-control.ahora-project.workers.dev" + path, { method: "POST", headers: {
    "content-type": "application/json", "X-KageCatch-Timestamp": timestamp,
    "X-KageCatch-Nonce": nonce, "X-KageCatch-Signature": sig,
  }, body });
}

function createFakeJobQueueDatabase() {
  const rows = new Map();
  return { rows, prepare(sql) { let values=[]; return { bind(...v) { values=v; return this; },
    async run() {
      if (sql.startsWith("INSERT OR IGNORE INTO catch_jobs")) {
        const [job_id,job_type,payload_json,priority,max_attempts,idempotency_key,run_after,created_at,updated_at]=values;
        if ([...rows.values()].some(r=>idempotency_key && r.idempotency_key===idempotency_key)) return {meta:{changes:0}};
        rows.set(job_id,{job_id,job_type,payload_json,priority,status:"queued",attempts:0,max_attempts,idempotency_key,worker_id:null,lease_until:null,lease_generation:0,run_after,created_at,updated_at}); return {meta:{changes:1}};
      }
      throw new Error("unexpected fake D1 run: "+sql);
    },
    async first() { if(sql.includes("WHERE job_id=?")) return rows.get(values[0])||null; if(sql.includes("WHERE idempotency_key = ?")) return [...rows.values()].find(r=>r.idempotency_key===values[0])||null; throw new Error("unexpected fake D1 first: "+sql); },
    async all() {
      if(sql.includes("UPDATE catch_jobs SET status='running'")) {
        const [worker_id,lease_until,updated_at,now,...types]=values;
        const row=[...rows.values()].filter(r=>r.status==="queued"&&r.run_after<=now&&(!types.length||types.includes(r.job_type))).sort((a,b)=>b.priority-a.priority||a.created_at-b.created_at)[0];
        if(!row)return {results:[]}; Object.assign(row,{status:"running",attempts:row.attempts+1,lease_generation:row.lease_generation+1,worker_id,lease_until,updated_at}); return {results:[{...row}]};
      }
      throw new Error("unexpected fake D1 all: "+sql);
    },
  }; }};
}

test("D1 durable job queue authenticates enqueue and atomically claims a fenced lease", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const db = createFakeJobQueueDatabase(), secret = "job-queue-core-secret-with-at-least-32-bytes";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: db };
  const created = await worker.fetch(await makeSignedJobQueueRequest({ action:"enqueue", job_type:"spawn.recognize", payload:{spawn_id:9}, priority:3, idempotency_key:"spawn:9" },secret),env);
  assert.equal(created.status,201); const job=(await created.json()).job; assert.equal(job.status,"queued");
  const claimed = await worker.fetch(await makeSignedJobQueueRequest({ action:"claim", worker_id:"worker-a", lease_seconds:60, job_types:["spawn.recognize"] },secret),env);
  assert.equal(claimed.status,200); const lease=(await claimed.json()).job; assert.equal(lease.status,"running"); assert.equal(lease.lease_generation,1);
  const unsigned=await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/internal/job-queue",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),env);
  assert.equal(unsigned.status,401);
});

function createFakeCatchAdmissionDatabase() {
  const rows = new Map();
  return { rows, prepare(sql) { let values = []; return {
    bind(...args) { values = args; return this; },
    async run() {
      if (!sql.includes("INSERT INTO catch_admission_attempts")) throw new Error("unexpected catch admission run: " + sql);
      const [dedupeKey, userId, source, attemptedAt, duplicateKey, quotaUser, quotaSource, cutoff, maxAttempts] = values;
      if (rows.has(duplicateKey)) return { meta: { changes: 0 } };
      const count = [...rows.values()].filter((row) => row.user_id === quotaUser && row.source === quotaSource && row.attempted_at > cutoff).length;
      if (count >= maxAttempts) return { meta: { changes: 0 } };
      rows.set(dedupeKey, { dedupe_key: dedupeKey, user_id: userId, source, attempted_at: attemptedAt });
      return { meta: { changes: 1 } };
    },
    async first() {
      if (!sql.includes("SELECT 1 AS found FROM catch_admission_attempts")) throw new Error("unexpected catch admission first: " + sql);
      return rows.has(values[0]) ? { found: 1 } : null;
    },
  }; }};
}

test("D1 catch admission is authenticated, atomic, deduplicated, and quota bounded", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const db = createFakeCatchAdmissionDatabase();
  const secret = "catch-admission-core-secret-at-least-32-bytes";
  const env = { CORE_API_SECRET: secret, CONNECT_LINKS: binding, KAGECATCH_DB: db };
  const reserve = async (dedupe_key, nonce, source = "senpai_catcher") => worker.fetch(await makeSignedJobQueueRequest({
    action: "admit_catch", user_id: "12345", source, dedupe_key,
    max_attempts: 2, window_seconds: 60,
  }, secret, nonce), env);
  const first = await reserve("spawn:1", "a".repeat(32));
  const duplicate = await reserve("spawn:1", "b".repeat(32));
  const second = await reserve("spawn:2", "c".repeat(32));
  const quota = await reserve("spawn:3", "d".repeat(32));
  assert.deepEqual(await first.json(), { status: "admitted" });
  assert.deepEqual(await duplicate.json(), { status: "duplicate" });
  assert.deepEqual(await second.json(), { status: "admitted" });
  assert.deepEqual(await quota.json(), { status: "quota_blocked" });
  const raced = await Promise.all([
    reserve("spawn:race", "f".repeat(32), "race_catcher"),
    reserve("spawn:race", "g".repeat(32), "race_catcher"),
  ]);
  const raceStatuses = await Promise.all(raced.map(async (response) => (await response.json()).status));
  assert.deepEqual(raceStatuses.sort(), ["admitted", "duplicate"]);
  assert.equal(db.rows.size, 3);
  const invalid = await worker.fetch(await makeSignedJobQueueRequest({ action: "admit_catch", user_id: "12345", source: "../bad", dedupe_key: "x", max_attempts: 2, window_seconds: 60 }, secret, "e".repeat(32)), env);
  assert.equal(invalid.status, 400);
});

test("claim-nonce cleanup bounds each storage scan and paginates expired nonce records", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const state = createDurableObjectState({ maxListLimit: 50 });
  const store = new ConnectionLinkStore(state);
  const expiredAt = Date.now() - 1000;
  for (let index = 0; index < 75; index += 1) {
    await state.storage.put(`internal-nonce:${String(index).padStart(3, "0")}`, expiredAt);
  }

  for (let index = 0; index < 2; index += 1) {
    const response = await store.fetch(new Request("https://do.internal/claim-nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: `new-nonce-id-${String(index).padStart(4, "0")}`, expiresAt: Date.now() + 120000 }),
    }));
    assert.equal(response.status, 200);
  }

  const remainingExpired = [...(await state.storage.list({ prefix: "internal-nonce:" })).entries()]
    .filter(([key, expiry]) => key.startsWith("internal-nonce:000") || expiry <= Date.now());
  assert.equal(remainingExpired.length, 0);
});
