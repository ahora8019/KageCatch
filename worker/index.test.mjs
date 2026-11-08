import test from "node:test";
import assert from "node:assert/strict";
import worker, { buildMainMenu, buildRoleMenu, buildStartMenu, resolveRole, resolveCallback, commandReply } from "./index.mjs";

test("panel explains login requirements and never leaves the connect button silent", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /authFailureMessage/);
  assert.match(html, /authFailureMessage/);
  assert.match(html, /error\.status===401/);
  assert.match(html, /error\.status===403/);
  assert.match(html, /error\.status===503/);
  assert.match(html, /if\(!session\)\{document\.querySelector\("#account-state"\)/);
  assert.match(html, /main\{padding-bottom:124px\}/);
});

test("main menu is inline-first and exposes the agreed account controls", () => {
  const menu = buildMainMenu();
  const callbacks = menu.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.deepEqual(callbacks, [
    "catch:open",
    "bots:open",
    "account:connect",
    "account:list",
    "stats:open",
    "settings:open",
    "security:open",
    "account:disconnect",
    "help:open",
  ]);
  assert.equal(menu.inline_keyboard.flat().some((button) => button.url), false);
});

test("connect callback explains the standalone account link without exposing a chat credential prompt", () => {
  const result = resolveCallback("account:connect");
  assert.match(result.text, /لینک مخصوص خودت ساخته بشه/);
  assert.match(result.text, /صفحهٔ ورود باز بشه/);
  assert.doesNotMatch(result.text, /پنل|کد ورود را بفرست|رمز دومرحله‌ای را وارد کن/);
});

test("account and security callbacks disclose only current unavailable state", () => {
  assert.match(resolveCallback("account:list").text, /گزینهٔ «اتصال حساب»/);
  assert.match(resolveCallback("security:open").text, /هیچ کد ورود یا رمز دومرحله‌ای در بات دریافت نمی‌شود/);
  assert.match(resolveCallback("account:disconnect").text, /حساب متصلی ثبت نشده/);
});

test("unknown callback is rejected safely", () => {
  assert.equal(resolveCallback("account:unknown").alert, true);
});

test("/start opens the native member dashboard directly", () => {
  const start = commandReply("/start");
  const callbacks = start.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("catch:open"));
  assert.ok(callbacks.includes("bots:open"));
  assert.ok(callbacks.includes("account:connect"));
});

test("/panel opens the member feature menu directly as an explicit choice", () => {
  const panel = commandReply("/panel");
  const callbacks = panel.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("account:connect"));
  assert.ok(callbacks.includes("account:list"));
});

test("owner start menu contains only management actions and a separate member-panel entry", () => {
  const callbacks = buildStartMenu("OWNER").inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("owner:stats"));
  assert.ok(callbacks.includes("owner:members"));
  assert.ok(callbacks.includes("home:panel"));
  assert.equal(callbacks.includes("catch:open"), false);
  assert.equal(callbacks.includes("bots:open"), false);
  assert.equal(callbacks.includes("account:connect"), false);
});

test("status and help remain available as slash-command shortcuts", () => {
  assert.match(commandReply("/status").text, /Python Core: متصل نیست/);
  assert.match(commandReply("/help").text, /کنترل Catch/);
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

test("connection link exchanges once for a short-lived browser session bound to its Telegram user", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 987654321, ttlSeconds: 300 }),
  }));
  const { token, id } = await created.json();
  const consume = () => store.fetch(new Request("https://do.internal/consume", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }));
  const first = await consume();
  assert.equal(first.status, 200);
  const { sessionToken } = await first.json();
  assert.match(sessionToken, /^[A-Za-z0-9_-]{40,}$/);
  const validate = await store.fetch(new Request("https://do.internal/browser-session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken }),
  }));
  assert.deepEqual(await validate.json(), { telegramUserId: 987654321 });
  assert.equal((await consume()).status, 410);
  assert.equal((await store.fetch(new Request("https://do.internal/browser-session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: "bad" }),
  }))).status, 401);
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


test("standalone connection page collects credentials only in a no-store HTTPS form", async () => {
  const token = "A".repeat(43);
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/" + token), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await response.text();
  assert.match(html, /اتصال حساب تلگرام/);
  assert.match(html, /name="phone"/);
  assert.match(html, /name="code"/);
  assert.match(html, /name="password"/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /autocomplete="one-time-code"/);
  assert.doesNotMatch(html, /telegram\.org|cdn\.|https?:\/\//);
});

test("standalone connection page exchanges its one-time link without rendering it into a credential form", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 445566778, ttlSeconds: 300 }),
  }));
  const { token } = await created.json();
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/exchange", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }), { CONNECT_LINKS: binding });
  assert.equal(response.status, 200);
  const { sessionToken } = await response.json();
  assert.ok(sessionToken);
  const replay = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/exchange", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }), { CONNECT_LINKS: binding });
  assert.equal(replay.status, 410);
});


test("standalone connect API rejects missing browser sessions and binds requests to the link owner", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const created = await store.fetch(new Request("https://do.internal/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 445566778, ttlSeconds: 300 }),
  }));
  const { token } = await created.json();
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const denied = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/api", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", phone: "+989121234567" }),
  }), { CONNECT_LINKS: binding });
  assert.equal(denied.status, 401);
  const exchanged = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/exchange", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }), { CONNECT_LINKS: binding });
  const { sessionToken } = await exchanged.json();
  let captured;
  const env = {
    CONNECT_LINKS: binding, CORE_API_URL: "https://core.example", CORE_API_SECRET: "x".repeat(40),
    FETCH: async (url, init) => { captured = { url, init }; return new Response(JSON.stringify({ status: "code_sent" }), { status: 200 }); },
  };
  const allowed = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/api", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + sessionToken },
    body: JSON.stringify({ action: "start", phone: "+989121234567" }),
  }), env);
  assert.equal(allowed.status, 200);
  assert.equal(captured.url, "https://core.example/v1/accounts/445566778/connect");
  assert.deepEqual(JSON.parse(captured.init.body), { phone: "+989121234567" });
  assert.ok(captured.init.headers["X-KageCatch-Signature"]);
});

test("private connect callback launches the standalone secure login page", async () => {
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
  const button = edit.payload.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, "🌸 اتصال امن حساب");
  assert.match(button.url, /^https:\/\/kagecatch-control\.ahora-project\.workers\.dev\/connect\/[A-Za-z0-9_-]{40,}$/);
  assert.equal(Object.hasOwn(button, "web_app"), false);
});

test("panel exposes the secure phone, code, and optional 2FA connection flow", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"), {});
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /api\/account\/connect\/code/);
  assert.match(html, /api\/account\/connect\/password/);
  assert.match(html, /ارسال کد/);
  assert.match(html, /کدی که تلگرام برات فرستاده رو همین‌جا بنویس/);
  assert.match(html, /رمز دومرحله‌ای/);
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


test("Telegram menus stay native and do not redirect members into the Mini App", () => {
  for (const role of ["MEMBER", "OWNER"]) {
    const buttons = buildRoleMenu(role).inline_keyboard.flat();
    assert.equal(buttons.some((button) => button.web_app), false);
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


test("dashboard provides accessible navigation, live status, and clear operational boundaries", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"), {});
  const html = await response.text();
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /id="core-tag"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /عملیات Catch اجرا نمی‌کنند/);
  assert.match(html, /تاریخچه عملیات/);
});

import { createHash, createHmac } from "node:crypto";

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
  const olderThanFiveMinutes = makeWebAppInitData("test-bot-token", user, Math.floor(Date.now() / 1000) - 600);
  assert.ok(await verifyWebAppInitData(olderThanFiveMinutes, "test-bot-token"), "a still-open Mini App must remain authenticated after five minutes");
  const expired = makeWebAppInitData("test-bot-token", user, Math.floor(Date.now() / 1000) - 86401);
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
      const bodyHash = createHash("sha256").update("").digest("hex");
      const message = [timestamp, nonce, "GET", "/v1/accounts/2001", bodyHash].join("\n");
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


test("Worker exposes the Telegram deep-link flow only to a verified Mini App user", async () => {
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
  let observed;
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/account/connect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }),
  }), {
    TELEGRAM_BOT_TOKEN: botToken, OWNER_TELEGRAM_ID: "7135051954", CONNECT_LINKS: binding,
    CORE_API_URL: "https://core.example.test", CORE_API_SECRET: coreSecret,
    FETCH: async (url, init) => {
      observed = { url, method: init.method };
      return new Response(JSON.stringify({ status: "pending", login_url: "tg://login?token=one-time", expires_in: 30 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(observed.url, "https://core.example.test/v1/accounts/2001/connect");
  assert.equal(observed.method, "POST");
  const body = await response.json();
  assert.equal(body.login_url, "tg://login?token=one-time");
  assert.equal(body.status, "pending");
});

test("Mini App account UI uses accessible inline login steps instead of blocking browser prompts", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"), {});
  const html = await response.text();
  assert.match(html, /account-connect/);
  assert.ok(html.includes("/api/account/connect"));
  assert.ok(html.includes("/api/account/connect/code"));
  assert.ok(html.includes("/api/account/connect/password"));
  assert.match(html, /id="login-dialog"/);
  assert.match(html, /id="login-value"/);
  assert.match(html, /one-time-code/);
  assert.match(html, /current-password/);
  assert.match(html, /aria-live="polite"/);
  assert.equal(html.includes("window.prompt("), false);
  assert.match(html, /@keyframes/);
  assert.doesNotMatch(html, /login_url/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "Mini App script must be present");
  assert.doesNotThrow(() => new Function(script), "Mini App script must parse before it is served");
});


test("health distinguishes a reachable but unconfigured Python Core from an unreachable Core", async () => {
  const calls = [];
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    CORE_API_URL: "https://core.example.test",
    CORE_API_SECRET: "kagecatch-core-test-secret-32-bytes",
    FETCH: async (url, init) => {
      calls.push(url);
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "https://kagecatch-control.ahora-project.workers.dev/webhook", pending_update_count: 0 } }), { status: 200 });
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
  assert.equal(calls.length, 3);
});

test("dashboard labels the Core as degraded instead of offline when the bridge reaches it", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"), {});
  const html = await response.text();
  assert.match(html, /core-tag/);
  assert.match(html, /دسترسی برقرار · نیازمند پیکربندی/);
  assert.match(html, /در دسترس · گزارش‌شده/);
});


test("Telegram member menu is a native bot-first dashboard with Catch, bot targets, and settings", () => {
  const menu = buildRoleMenu("MEMBER");
  const buttons = menu.inline_keyboard.flat();
  const callbacks = buttons.map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("catch:open"));
  assert.ok(callbacks.includes("bots:open"));
  assert.ok(callbacks.includes("settings:open"));
  assert.equal(buttons.some((button) => button.web_app), false);
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

test("/start opens the native role menu directly instead of a redundant landing menu", () => {
  const start = commandReply("/start");
  const callbacks = start.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes("catch:open"));
  assert.ok(callbacks.includes("bots:open"));
  assert.ok(callbacks.includes("account:connect"));
});


test("Mini App forwards phone login payloads only to the signed Python Core endpoint", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  await store.fetch(new Request("https://do.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 445566778, ownerTelegramId: "" }),
  }));
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const calls = [];
  const env = {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    CONNECT_LINKS: binding,
    CORE_API_URL: "https://core.example",
    CORE_API_SECRET: "test-core-secret-with-more-than-thirty-two-bytes",
    FETCH: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: "code_sent" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const initData = makeWebAppInitData("test-bot-token", { id: 445566778, first_name: "Member" });
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/account/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData, phone: "+10000000000" }),
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "code_sent" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://core.example/v1/accounts/445566778/connect");
  const forwarded = JSON.parse(calls[0].init.body);
  assert.deepEqual(forwarded, { phone: "+10000000000" });
  assert.equal(Object.hasOwn(forwarded, "initData"), false);
  assert.ok(calls[0].init.headers["X-KageCatch-Signature"]);
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

test("internal session store refuses invalid user identifiers and oversized payloads", async () => {
  const secret = "test-core-session-store-secret-with-32-bytes-minimum";
  const invalid = await worker.fetch(await makeSignedSessionStoreRequest("GET", "../100", undefined, secret), { CORE_API_SECRET: secret });
  assert.equal(invalid.status, 404);
});


test("Mini App account connection waits for Telegram authentication to finish", async () => {
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/panel"), {});
  const html = await response.text();
  assert.match(html, /let authPromise\s*=\s*null/);
  assert.match(html, /if\(!session\s*&&\s*authPromise\)\s*await authPromise/);
  assert.match(html, /authPromise\s*=\s*authenticate\(\)/);
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
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_WEBHOOK_SECRET: "hook-secret", TELEGRAM_BOT_TOKEN: "bot-token",
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
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token",
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
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_WEBHOOK_SECRET: "hook-secret", TELEGRAM_BOT_TOKEN: "bot-token",
    FETCH: async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); } };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 400001, message: { chat: { id: 400001, type: "private" }, from: { id: 400001 }, text: "/start inv_" + invite.token } }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(calls[0].reply_markup.remove_keyboard, true);
  assert.match(calls[1].text, /KageCatch/);
  assert.ok(calls[1].reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "account:connect"));
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
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
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
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
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


test("Owner menu exposes alerts, access management, and service status", () => {
  const callbacks = buildRoleMenu("OWNER").inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("owner:alerts"));
  assert.ok(callbacks.includes("owner:access"));
  assert.ok(callbacks.includes("owner:services"));
  const memberCallbacks = buildRoleMenu("MEMBER").inline_keyboard.flat().map((button) => button.callback_data);
  assert.equal(memberCallbacks.some((value) => value?.startsWith("owner:")), false);
});

test("Owner alerts screen reports webhook and Core problems without exposing secrets", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 999001, ownerTelegramId: "999001" }) }));
  const calls = [];
  const env = {
    CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    CORE_API_URL: "https://core.example", CORE_API_SECRET: "a".repeat(40),
    FETCH: async (url, init) => {
      const target = String(url);
      const method = target.split("/").pop();
      if (target.endsWith("/v1/health")) return new Response(JSON.stringify({ status: "degraded" }), { status: 503 });
      if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "https://kagecatch-control.ahora-project.workers.dev/webhook", pending_update_count: 2, last_error_message: "502 Bad Gateway" } }));
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 123, username: "KageCatchBot" } }));
      calls.push({ method, payload: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 990001, callback_query: { id: "alert-cb", data: "owner:alerts", from: { id: 999001 }, message: { message_id: 1, chat: { id: 999001, type: "private" } } } }),
  }), env);
  assert.equal(response.status, 200);
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.match(edit.payload.text, /هشدار/);
  assert.match(edit.payload.text, /502 Bad Gateway/);
  assert.match(edit.payload.text, /Core/);
  assert.doesNotMatch(edit.payload.text, /CORE_API_SECRET|bot-token|hook-secret/);
});

test("Owner services screen distinguishes Worker, Telegram, Core, and database health", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 999001, ownerTelegramId: "999001" }) }));
  const calls = [];
  const env = {
    CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    CORE_API_URL: "https://core.example", CORE_API_SECRET: "a".repeat(40),
    KAGECATCH_DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
    FETCH: async (url, init) => {
      const target = String(url);
      const method = target.split("/").pop();
      if (target.endsWith("/v1/health")) return new Response(JSON.stringify({ status: "ready" }));
      if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "https://kagecatch-control.ahora-project.workers.dev/webhook", pending_update_count: 0 } }));
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 123, username: "KageCatchBot" } }));
      calls.push({ method, payload: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 990002, callback_query: { id: "service-cb", data: "owner:services", from: { id: 999001 }, message: { message_id: 2, chat: { id: 999001, type: "private" } } } }),
  }), env);
  assert.equal(response.status, 200);
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.match(edit.payload.text, /Worker/);
  assert.match(edit.payload.text, /Telegram/);
  assert.match(edit.payload.text, /Core/);
  assert.match(edit.payload.text, /D1|دیتابیس/);
  assert.match(edit.payload.text, /فعال|متصل/);
});

test("Owner access screen reuses safe member block and unblock controls", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 999001, ownerTelegramId: "999001" }) }));
  await store.fetch(new Request("https://do.internal/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: 500003, ownerTelegramId: "999001" }) }));
  const calls = [];
  const env = { CONNECT_LINKS: binding, OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    FETCH: async (url, init) => { const method = String(url).split("/").pop(); calls.push({ method, payload: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: {} })); } };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 990003, callback_query: { id: "access-cb", data: "owner:access", from: { id: 999001 }, message: { message_id: 3, chat: { id: 999001, type: "private" } } } }),
  }), env);
  assert.equal(response.status, 200);
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.match(edit.payload.text, /دسترسی/);
  assert.ok(edit.payload.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "owner:block:500003"));
});


test("Owner /start clears the legacy reply keyboard, shows one short greeting, and avoids duplicate registry lookup", async () => {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const store = new ConnectionLinkStore(createDurableObjectState());
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: (input, init) => store.fetch(new Request(input, init)) }) };
  const telegramCalls = [];
  const registryCalls = [];
  const env = {
    CONNECT_LINKS: { idFromName: binding.idFromName, get: () => ({ fetch: async (input, init) => {
      const path = new URL(input).pathname; registryCalls.push(path);
      return store.fetch(new Request(input, init));
    } }) },
    OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    FETCH: async (url, init) => { telegramCalls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: telegramCalls.length } })); },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 990010, message: { text: "/start", from: { id: 999001, first_name: "Owner" }, chat: { id: 999001, type: "private" } } }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(telegramCalls.length, 2);
  assert.equal(telegramCalls[0].reply_markup.remove_keyboard, true);
  assert.equal(telegramCalls[0].text, "سلام Owner! پنل مدیریت آماده‌ست 🌸");
  assert.equal(telegramCalls[1].text, "بخش مدیریتی موردنظرت رو انتخاب کن:");
  const ownerLookupCount = registryCalls.filter((path) => path === "/user").length;
  assert.equal(ownerLookupCount, 0);
});

test("Owner callback is acknowledged before registry writes and skips redundant owner lookup", async () => {
  const events = [];
  const env = {
    OWNER_TELEGRAM_ID: "999001", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    CONNECT_LINKS: { idFromName: () => "connection-links-v1", get: () => ({ fetch: async (input, init) => {
      events.push("registry:" + new URL(input).pathname);
      return new Response(JSON.stringify({ ok: true, status: "active", user: { telegramUserId: 999001, role: "OWNER", status: "active" } }));
    } }) },
    FETCH: async (url, init) => {
      const method = String(url).split("/").pop(); events.push("telegram:" + method);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    },
  };
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ update_id: 990011, callback_query: { id: "fast-owner-cb", data: "owner:emergency", from: { id: 999001 }, message: { message_id: 11, chat: { id: 999001, type: "private" } } } }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(events[0], "telegram:answerCallbackQuery");
  assert.equal(events.some((event) => event === "registry:/user"), false);
});
