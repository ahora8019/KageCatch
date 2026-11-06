import test from "node:test";
import assert from "node:assert/strict";
import worker, { buildMainMenu, buildRoleMenu, buildStartMenu, resolveRole, resolveCallback, commandReply } from "./index.mjs";

test("main menu is inline-first and exposes the agreed account controls", () => {
  const menu = buildMainMenu();
  const callbacks = menu.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.deepEqual(callbacks, [
    "account:connect",
    "account:list",
    "stats:open",
    "security:open",
    "account:disconnect",
    "help:open",
  ]);
  assert.equal(menu.inline_keyboard.flat().some((button) => button.url), false);
});

test("connect callback never asks for a phone, login code, or 2FA password", () => {
  const result = resolveCallback("account:connect");
  assert.match(result.text, /اتصال امن هنوز فعال نشده/);
  assert.match(result.text, /کد ورود یا رمز دومرحله‌ای را اینجا ارسال نکن/);
  assert.doesNotMatch(result.text, /شماره تلفن خود را وارد کن|کد ورود را بفرست|رمز دومرحله‌ای را وارد کن/);
});

test("account and security callbacks disclose only current unavailable state", () => {
  assert.match(resolveCallback("account:list").text, /هسته اجرایی هنوز متصل نیست/);
  assert.match(resolveCallback("security:open").text, /هیچ کد ورود یا رمز دومرحله‌ای در بات دریافت نمی‌شود/);
  assert.match(resolveCallback("account:disconnect").text, /حساب متصلی ثبت نشده/);
});

test("unknown callback is rejected safely", () => {
  assert.equal(resolveCallback("account:unknown").alert, true);
});

test("/start opens a separate welcome menu instead of dropping users into the panel", () => {
  const start = commandReply("/start");
  const callbacks = start.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.deepEqual(callbacks, ["home:panel", "home:status", "home:help"]);
  assert.equal(callbacks.includes("account:connect"), false);
  assert.equal(callbacks.includes("owner:members"), false);
});

test("/panel opens the member feature menu directly as an explicit choice", () => {
  const panel = commandReply("/panel");
  const callbacks = panel.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("account:connect"));
  assert.ok(callbacks.includes("account:list"));
});

test("owner start menu separates admin entry from member panel entry", () => {
  const callbacks = buildStartMenu("OWNER").inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.deepEqual(callbacks, ["home:admin", "home:panel", "home:status", "home:help"]);
});

test("status and help remain available as slash-command shortcuts", () => {
  assert.match(commandReply("/status").text, /Python Core: متصل نیست/);
  assert.match(commandReply("/help").text, /دکمه‌های منوی اصلی/);
});


function createDurableObjectState() {
  const values = new Map();
  let tail = Promise.resolve();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async list({ prefix = "" } = {}) { return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix))); },
    async transaction(callback) {
      const run = tail.then(() => callback(storage));
      tail = run.catch(() => {});
      return run;
    },
  };
  return { storage };
}

test("connection link store creates an opaque, short-lived token bound to one Telegram user", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const response = await store.fetch(new Request("https://do.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 123456789, ttlSeconds: 300 }),
  }));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(result.expiresIn, 300);
  assert.equal(Object.hasOwn(result, "telegramUserId"), false);
});

test("connection link store consumes a token exactly once", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 987654321, ttlSeconds: 300 }),
  }));
  const { token } = await created.json();
  const consume = () => store.fetch(new Request("https://do.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  const first = await consume();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { valid: true });
  const replay = await consume();
  assert.equal(replay.status, 410);
});

test("connection link store rejects expired links", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 123456789, ttlSeconds: 60 }),
  }));
  const { token } = await created.json();
  const originalNow = Date.now;
  Date.now = () => originalNow() + 61_000;
  const response = await store.fetch(new Request("https://do.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  Date.now = originalNow;
  assert.equal(response.status, 410);
});

test("connection link store rejects malformed requests and unsupported methods", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  assert.equal((await store.fetch(new Request("https://do.internal/create"))).status, 405);
  const invalid = await store.fetch(new Request("https://do.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: "not-a-number", ttlSeconds: 300 }),
  }));
  assert.equal(invalid.status, 400);
});


test("connection link store permits only one winner for concurrent consume attempts", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 112233445, ttlSeconds: 300 }),
  }));
  const { token } = await created.json();
  const consume = () => store.fetch(new Request("https://do.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  const results = await Promise.all([consume(), consume()]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 410]);
});


test("connection landing page does not request Telegram credentials", async () => {
  const token = "A".repeat(43);
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/" + token), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const html = await response.text();
  assert.match(html, /کد ورود یا رمز دومرحله‌ای وارد نکن/);
  assert.doesNotMatch(html, /name=phone|name=code|name=password/i);
});

test("connection landing page consumes the matching link on explicit POST", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 445566778, ttlSeconds: 300 }),
  }));
  const { token } = await created.json();
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const form = new FormData();
  form.set("token", token);
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/" + token, { method: "POST", body: form }), { CONNECT_LINKS: binding });
  const responseBody = await response.text();
  assert.equal(response.status, 200, responseBody);
  assert.match(responseBody, /این به معنی اتصال حساب تلگرام نیست/);
  const replay = await store.fetch(new Request("https://do.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  assert.equal(replay.status, 410);
});


test("private connect callback issues a live one-time link through the Durable Object", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 556677889, ownerTelegramId: "" }) }));
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const telegramCalls = [];
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    CONNECT_LINKS: binding,
    FETCH: async (url, init) => {
      telegramCalls.push({ method: url.split("/").pop(), payload: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const update = {
    update_id: 42,
    callback_query: {
      id: "callback-42",
      from: { id: 556677889 },
      message: { message_id: 7, chat: { id: 556677889, type: "private" } },
      data: "account:connect",
    },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
    body: JSON.stringify(update),
  }), env);
  assert.equal(response.status, 200);
  const edit = telegramCalls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  const link = edit.payload.reply_markup.inline_keyboard[0][0].url;
  assert.match(link, /^https:\/\/kagecatch-control\.ahora-project\.workers\.dev\/connect\/[A-Za-z0-9_-]{40,}$/);
  const token = new URL(link).pathname.split("/").pop();
  const consumed = await store.fetch(new Request("https://do.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  assert.equal(consumed.status, 200);
});


test("owner role is assigned only to the configured numeric Telegram ID", () => {
  assert.equal(resolveRole(1001, "1001", "MEMBER", "active"), "OWNER");
  assert.equal(resolveRole(1002, "1001", "MEMBER", "active"), "MEMBER");
  assert.equal(resolveRole(1001, "1002", "MEMBER", "active"), "MEMBER");
});

test("blocked users cannot enter even if their stored role says MEMBER", () => {
  assert.equal(resolveRole(1002, "1001", "MEMBER", "blocked"), "BLOCKED");
});

test("member menu contains only personal account and catch features", () => {
  const callbacks = buildRoleMenu("MEMBER").inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("account:list"));
  assert.ok(callbacks.includes("account:connect"));
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
    TELEGRAM_BOT_TOKEN: "test-token",
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
    TELEGRAM_BOT_TOKEN: "test-token",
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


test("start menu exposes the professional Mini App without removing command shortcuts", () => {
  const menu = buildStartMenu("MEMBER");
  const buttons = menu.inline_keyboard.flat();
  const app = buttons.find((button) => button.web_app?.url);
  assert.equal(app?.text, "🌸 پنل حرفه‌ای");
  assert.equal(app.web_app.url, "https://kagecatch-control.ahora-project.workers.dev/panel");
});

test("role menus expose the same Mini App to members and owners", () => {
  for (const role of ["MEMBER", "OWNER"]) {
    const buttons = buildRoleMenu(role).inline_keyboard.flat();
    assert.ok(buttons.some((button) => button.web_app?.url === "https://kagecatch-control.ahora-project.workers.dev/panel"));
  }
});

test("professional panel is responsive, Persian-first, and reports offline core honestly", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const html = await response.text();
  assert.match(html, /KageCatch/);
  assert.match(html, /viewport/);
  assert.match(html, /Python Core/);
  assert.match(html, /متصل نیست/);
  assert.match(html, /Telegram/);
  assert.match(html, /aria-label/);
  const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];
  assert.ok(nonce);
  assert.match(response.headers.get("content-security-policy"), new RegExp("nonce-" + nonce));
});


import { createHmac } from "node:crypto";

function makeWebAppInitData(botToken, user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(user),
  });
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => key + "=" + value).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

test("Mini App initData verification accepts a fresh Telegram signature", async () => {
  const { verifyWebAppInitData } = await import("./index.mjs");
  const user = { id: 7135051954, first_name: "Ahura", username: "ahora_8019" };
  const initData = makeWebAppInitData("test-bot-token", user);
  const verified = await verifyWebAppInitData(initData, "test-bot-token");
  assert.equal(verified.user.id, user.id);
  assert.equal(verified.user.username, user.username);
});

test("Mini App initData verification rejects tampering and expired signatures", async () => {
  const { verifyWebAppInitData } = await import("./index.mjs");
  const user = { id: 2001, first_name: "Member" };
  const initData = makeWebAppInitData("test-bot-token", user);
  const tampered = initData.replace("Member", "Attacker");
  assert.equal(await verifyWebAppInitData(tampered, "test-bot-token"), null);
  const expired = makeWebAppInitData("test-bot-token", user, Math.floor(Date.now() / 1000) - 600);
  assert.equal(await verifyWebAppInitData(expired, "test-bot-token"), null);
});

test("Mini App session API trusts only signed Telegram identity and server-side role", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  await store.fetch(new Request("https://do.internal/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 7135051954, ownerTelegramId: "7135051954" }),
  }));
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const token = "test-bot-token";
  const initData = makeWebAppInitData(token, { id: 7135051954, first_name: "Ahura" });
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  }), { TELEGRAM_BOT_TOKEN: token, OWNER_TELEGRAM_ID: "7135051954", CONNECT_LINKS: binding });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, "OWNER");
  assert.equal(body.user.id, 7135051954);
  assert.equal(body.core_status, "not_connected");
});

test("Mini App session API rejects forged Telegram identity", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: "user=%7B%22id%22%3A7135051954%7D&auth_date=1&hash=deadbeef" }),
  }), { TELEGRAM_BOT_TOKEN: "test-bot-token" });
  assert.equal(response.status, 401);
});

// Mini App authentication regression coverage.


test("Mini App session role is read from the registry, not from client-supplied claims", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const post = (path, payload) => store.fetch(new Request("https://do.internal" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  await post("/register", { telegramUserId: 2001, ownerTelegramId: "7135051954" });
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const token = "test-bot-token";
  const initData = makeWebAppInitData(token, { id: 2001, first_name: "Member", role: "OWNER" });
  const request = () => worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData, role: "OWNER" }),
  }), { TELEGRAM_BOT_TOKEN: token, OWNER_TELEGRAM_ID: "7135051954", CONNECT_LINKS: binding });
  const memberResponse = await request();
  assert.equal(memberResponse.status, 200);
  assert.equal((await memberResponse.json()).role, "MEMBER");
  await post("/manage-user", { telegramUserId: 2001, action: "block" });
  assert.equal((await request()).status, 403);
});


test("Worker proxies account status to Core with an HMAC signature and trusted Telegram ID", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  await store.fetch(new Request("https://do.internal/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 2001, ownerTelegramId: "7135051954" }),
  }));
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const botToken = "test-bot-token";
  const coreSecret = "kagecatch-core-test-secret-32-bytes";
  const initData = makeWebAppInitData(botToken, { id: 2001, first_name: "Member" });
  let coreRequest;
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    OWNER_TELEGRAM_ID: "7135051954",
    CONNECT_LINKS: binding,
    CORE_API_URL: "https://core.example.test",
    CORE_API_SECRET: coreSecret,
    FETCH: async (url, init) => {
      coreRequest = { url, method: init.method, headers: init.headers };
      const timestamp = init.headers["X-KageCatch-Timestamp"];
      const nonce = init.headers["X-KageCatch-Nonce"];
      const bodyHash = createHmac("sha256", "").update("").digest("hex");
      const message = [timestamp, nonce, "GET", "/v1/accounts/2001", bodyHash].join("\\n");
      const expected = createHmac("sha256", coreSecret).update(message).digest("hex");
      assert.equal(init.headers["X-KageCatch-Signature"], expected);
      return new Response(JSON.stringify({ telegram_user_id: 2001, status: "not_connected", session_saved: false, connected: false }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/account/status", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData, telegram_user_id: 7135051954 }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(coreRequest.url, "https://core.example.test/v1/accounts/2001");
  assert.equal(coreRequest.method, "GET");
  assert.equal((await response.json()).status, "not_connected");
});

test("Worker does not call Core for forged Mini App identity", async () => {
  let called = false;
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/account/status", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: "user=%7B%22id%22%3A2001%7D&auth_date=1&hash=deadbeef" }),
  }), {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    CORE_API_URL: "https://core.example.test",
    CORE_API_SECRET: "kagecatch-core-test-secret-32-bytes",
    FETCH: async () => { called = true; return new Response("{}", { status: 200 }); },
  });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});
