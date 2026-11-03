import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const secret = "test-secret";
const bridgeSecret = "test-bridge-shared-secret-with-more-than-32-chars";

function env(fetchImpl) {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: secret,
    FETCH: fetchImpl,
  };
}

function webhook(update) {
  return new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(update),
  });
}

function telegramRecorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

test("/panel sends one private inline panel with stable navigation callbacks and Catch visibly off", async () => {
  const telegram = telegramRecorder();
  const response = await worker.fetch(webhook({
    update_id: 100,
    message: {
      from: { id: 99, is_bot: false },
      chat: { id: 99, type: "private" },
      text: "/panel",
    },
  }), env(telegram.fetchImpl));

  assert.equal(response.status, 200);
  const send = telegram.calls.find(call => call.url.endsWith("/sendMessage"));
  assert.ok(send);
  assert.equal(send.payload.chat_id, 99);
  assert.ok(Array.isArray(send.payload.reply_markup.inline_keyboard));
  const callbacks = send.payload.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(callbacks.includes("kc:home"));
  assert.ok(callbacks.includes("kc:bots"));
  assert.ok(callbacks.includes("kc:status"));
  assert.ok(callbacks.includes("kc:settings"));
  assert.ok(callbacks.includes("kc:stop"));
  assert.match(send.payload.text, /خاموش|غیرفعال/);
  assert.doesNotMatch(send.payload.text, /فعال است|روشن است/);
});

test("valid private callback acknowledges and edits the existing panel message", async () => {
  const telegram = telegramRecorder();
  const response = await worker.fetch(webhook({
    update_id: 101,
    callback_query: {
      id: "callback-1",
      from: { id: 99, is_bot: false },
      message: { message_id: 55, chat: { id: 99, type: "private" } },
      data: "kc:bots",
    },
  }), env(telegram.fetchImpl));

  assert.equal(response.status, 200);
  assert.ok(telegram.calls.some(call => call.url.endsWith("/answerCallbackQuery") &&
    call.payload.callback_query_id === "callback-1"));
  const edit = telegram.calls.find(call => call.url.endsWith("/editMessageText"));
  assert.ok(edit);
  assert.equal(edit.payload.chat_id, 99);
  assert.equal(edit.payload.message_id, 55);
  assert.match(edit.payload.text, /سنپای|هنتا|کاراکتر/);
  assert.ok(edit.payload.reply_markup.inline_keyboard);
});

test("rejects callbacks whose sender does not own the private chat", async () => {
  const telegram = telegramRecorder();
  const response = await worker.fetch(webhook({
    update_id: 102,
    callback_query: {
      id: "callback-forged",
      from: { id: 100, is_bot: false },
      message: { message_id: 55, chat: { id: 99, type: "private" } },
      data: "kc:home",
    },
  }), env(telegram.fetchImpl));

  assert.equal(response.status, 200);
  assert.ok(telegram.calls.some(call => call.url.endsWith("/answerCallbackQuery") &&
    call.payload.show_alert === true));
  assert.equal(telegram.calls.some(call => call.url.endsWith("/editMessageText")), false);
});

test("unknown callbacks are acknowledged safely without executing an action", async () => {
  const telegram = telegramRecorder();
  const response = await worker.fetch(webhook({
    update_id: 103,
    callback_query: {
      id: "callback-unknown",
      from: { id: 99, is_bot: false },
      message: { message_id: 55, chat: { id: 99, type: "private" } },
      data: "kc:catch:run",
    },
  }), env(telegram.fetchImpl));

  assert.equal(response.status, 200);
  assert.ok(telegram.calls.some(call => call.url.endsWith("/answerCallbackQuery")));
  assert.equal(telegram.calls.some(call => call.url.endsWith("/editMessageText")), false);
  assert.equal(telegram.calls.some(call => /catch|pick/i.test(call.url)), false);
});

test("emergency stop callback confirms Catch is already disabled and never dispatches Catch", async () => {
  const telegram = telegramRecorder();
  const response = await worker.fetch(webhook({
    update_id: 104,
    callback_query: {
      id: "callback-stop",
      from: { id: 99, is_bot: false },
      message: { message_id: 55, chat: { id: 99, type: "private" } },
      data: "kc:stop",
    },
  }), env(telegram.fetchImpl));

  assert.equal(response.status, 200);
  const answer = telegram.calls.find(call => call.url.endsWith("/answerCallbackQuery"));
  assert.ok(answer);
  assert.match(answer.payload.text, /خاموش|غیرفعال/);
  assert.equal(telegram.calls.some(call => /catch|pick/i.test(call.url)), false);
});
