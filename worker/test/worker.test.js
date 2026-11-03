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
  assert.match(sent.payload.text, /هنوز فعال نشده|آماده نیست/);
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


test("forwards only private /connect commands with a signed sanitized body", async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const calls = [];
  const bridgeSecret = "test-bridge-shared-secret-with-more-than-32-chars";
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).startsWith("https://core.example.test/")) {
      return new Response(JSON.stringify({
        ok: true,
        handled: true,
        reply: { chat_id: 99, text: "اتصال فعلاً فعال نیست." },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  const update = {
    update_id: 41,
    message: {
      message_id: 8,
      from: { id: 99, is_bot: false, first_name: "Test" },
      chat: { id: 99, type: "private", username: "private" },
      text: "/connect",
      date: 1800000000,
      caption: "must not be forwarded",
    },
  };
  const response = await worker.fetch(request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update),
  }), {
    ...env(fakeFetch),
    PYTHON_CORE_URL: "https://core.example.test",
    BRIDGE_SHARED_SECRET: bridgeSecret,
  });

  assert.equal(response.status, 200);
  const bridgeCall = calls.find(call => String(call.url).startsWith("https://core.example.test/"));
  assert.ok(bridgeCall);
  const forwarded = JSON.parse(bridgeCall.init.body);
  assert.deepEqual(forwarded, {
    update_id: 41,
    message: {
      from: { id: 99 },
      chat: { id: 99, type: "private" },
      text: "/connect",
    },
  });
  assert.equal(bridgeCall.init.method, "POST");
  assert.equal(bridgeCall.init.headers["content-type"], "application/json");

  const timestamp = bridgeCall.init.headers["X-KageCatch-Timestamp"];
  const nonce = bridgeCall.init.headers["X-KageCatch-Nonce"];
  const signature = bridgeCall.init.headers["X-KageCatch-Signature"];
  assert.equal(String(Number(timestamp)), timestamp);
  assert.match(nonce, /^[a-f0-9]{32}$/);
  const path = "/internal/telegram-update";
  const bodyHash = createHash("sha256").update(bridgeCall.init.body).digest("hex");
  const canonical = ["v1", "POST", path, timestamp, nonce, bodyHash].join("\n");
  const expected = createHmac("sha256", bridgeSecret).update(canonical).digest("hex");
  assert.equal(signature, expected);
  assert.ok(calls.some(call => String(call.url).includes("api.telegram.org") &&
    JSON.parse(call.init.body).text === "اتصال فعلاً فعال نیست."));
});

test("does not forward group commands or credential-like text to Python Core", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  const baseEnv = {
    ...env(fakeFetch),
    PYTHON_CORE_URL: "https://core.example.test",
    BRIDGE_SHARED_SECRET: "test-bridge-shared-secret-with-more-than-32-chars",
  };
  for (const message of [
    { from: { id: 99 }, chat: { id: -100, type: "group" }, text: "/connect" },
    { from: { id: 99 }, chat: { id: 99, type: "private" }, text: "123456" },
    { from: { id: 99 }, chat: { id: 100, type: "private" }, text: "/cancel" },
  ]) {
    const response = await worker.fetch(request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ update_id: 42, message }),
    }), baseEnv);
    assert.equal(response.status, 200);
  }
  assert.equal(calls, 0);
});

test("returns gateway failure when configured Python Core cannot be reached", async () => {
  const fakeFetch = async () => { throw new Error("network unavailable"); };
  const response = await worker.fetch(request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({
      update_id: 43,
      message: {
        from: { id: 99 },
        chat: { id: 99, type: "private" },
        text: "/cancel",
      },
    }),
  }), {
    ...env(fakeFetch),
    PYTHON_CORE_URL: "https://core.example.test",
    BRIDGE_SHARED_SECRET: "test-bridge-shared-secret-with-more-than-32-chars",
  });
  assert.equal(response.status, 502);
});
