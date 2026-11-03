import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const secret = "test-secret";
function request(path, init = {}) {
  return new Request(`https://example.test${path}`, init);
}
function env(fetchImpl) {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: secret,
    fetch: fetchImpl,
  };
}

test("rejects webhook requests without the Telegram secret header", async () => {
  const response = await worker.fetch(request("/webhook", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ update_id: 1 }),
  }), env(fetch));
  assert.equal(response.status, 401);
});

test("rejects malformed JSON after authenticating the webhook", async () => {
  const response = await worker.fetch(request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: "{",
  }), env(fetch));
  assert.equal(response.status, 400);
});

test("rejects updates without a valid update_id", async () => {
  const response = await worker.fetch(request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ message: { text: "/start" } }),
  }), env(fetch));
  assert.equal(response.status, 400);
});

test("answers /start using Telegram Bot API", async () => {
  let sent;
  const fakeFetch = async (url, init) => {
    sent = { url, payload: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), { status: 200 });
  };
  const response = await worker.fetch(request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: 10, message: { chat: { id: 99 }, text: "/start" } }),
  }), env(fakeFetch));
  assert.equal(response.status, 200);
  assert.equal(sent.payload.chat_id, 99);
  assert.match(sent.payload.text, /KageCatch/);
});

test("does not send a reply for unknown non-command messages", async () => {
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const response = await worker.fetch(request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: 11, message: { chat: { id: 99 }, text: "hello" } }),
  }), env(fakeFetch));
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});

test("serves a control panel page", async () => {
  const response = await worker.fetch(request("/panel"), env(fetch));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /پنل کنترل KageCatch/);
});

test("rejects GET requests to webhook", async () => {
  const response = await worker.fetch(request("/webhook"), env(fetch));
  assert.equal(response.status, 405);
});
