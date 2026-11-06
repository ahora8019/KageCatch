import test from "node:test";
import assert from "node:assert/strict";
import worker, { buildMainMenu, resolveCallback, commandReply } from "./index.mjs";

test("main menu is inline-first and exposes the agreed account controls", () => {
  const menu = buildMainMenu();
  const callbacks = menu.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(callbacks, [
    "account:connect",
    "account:list",
    "settings:open",
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

test("start and panel commands return the inline menu", () => {
  const start = commandReply("/start");
  const panel = commandReply("/panel");
  assert.equal(start.reply_markup.inline_keyboard.length, 5);
  assert.deepEqual(panel.reply_markup, start.reply_markup);
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
  const binding = { idFromName: () => "connection-links-v1", get: () => ({ fetch: store.fetch.bind(store) }) };
  const form = new FormData();
  form.set("token", token);
  const response = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/connect/" + token, { method: "POST", body: form }), { CONNECT_LINKS: binding });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /این به معنی اتصال حساب تلگرام نیست/);
  const replay = await store.fetch(new Request("https://do.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  assert.equal(replay.status, 410);
});
