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
    FETCH: fetchImpl,
  };
}

async function sendCommand(text, fetchImpl = async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })) {
  let sent;
  const wrappedFetch = async (url, init) => {
    sent = { url, payload: JSON.parse(init.body) };
    return fetchImpl(url, init);
  };
  const response = await worker.fetch(request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: 10, message: { chat: { id: 99 }, text } }),
  }), env(wrappedFetch));
  return { response, sent };
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

test("introduces KageCatch as a catcher and pick assistant without infrastructure jargon", async () => {
  const { response, sent } = await sendCommand("/start");
  assert.equal(response.status, 200);
  assert.equal(sent.payload.chat_id, 99);
  assert.match(sent.payload.text, /کچ|Catch/i);
  assert.match(sent.payload.text, /پیک|Pick/i);
  assert.doesNotMatch(sent.payload.text, /Worker|سرور|Webhook|Python Core/i);
});

test("/panel describes catchers and clearly states catch execution is not active yet", async () => {
  const { sent } = await sendCommand("/panel");
  assert.match(sent.payload.text, /SenpaiCatcherBot/);
  assert.match(sent.payload.text, /HentaCatcherBot/);
  assert.match(sent.payload.text, /Character_Catcher_Bot/);
  assert.match(sent.payload.text, /فعال نیست|آماده نیست/);
  assert.doesNotMatch(sent.payload.text, /Worker|سرور|Webhook|Python Core/i);
});

test("/status reports user-facing catch readiness without infrastructure details", async () => {
  const { sent } = await sendCommand("/status");
  assert.match(sent.payload.text, /کچ|Catch/i);
  assert.doesNotMatch(sent.payload.text, /Worker|سرور|Webhook|Python Core/i);
});

test("/help explains catch and pick commands without claiming they run here already", async () => {
  const { sent } = await sendCommand("/help");
  assert.match(sent.payload.text, /\/pick/);
  assert.match(sent.payload.text, /\/catch/);
  assert.match(sent.payload.text, /فعلاً|هنوز/);
  assert.doesNotMatch(sent.payload.text, /Worker|سرور|Webhook|Python Core/i);
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
