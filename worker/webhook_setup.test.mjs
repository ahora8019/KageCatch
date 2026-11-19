import test from "node:test";
import assert from "node:assert/strict";
import { ensureTelegramWebhook, EXPECTED_WEBHOOK_URL } from "./webhook_setup.mjs";

function telegramResponse(result, ok = true) {
  return new Response(JSON.stringify({ ok, result }), {
    status: ok ? 200 : 400,
    headers: { "content-type": "application/json" },
  });
}

test("keeps an already-correct Telegram webhook without resetting pending updates", async () => {
  const calls = [];
  const env = {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123",
    FETCH: async (url, init) => {
      calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
      return telegramResponse({ url: EXPECTED_WEBHOOK_URL, pending_update_count: 2 });
    },
  };

  const result = await ensureTelegramWebhook(env);

  assert.equal(result.status, "already_configured");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "getWebhookInfo");
});

test("repairs a mismatched webhook and verifies Telegram accepted the exact target", async () => {
  const calls = [];
  let currentUrl = "https://old.example/webhook";
  const env = {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123",
    FETCH: async (url, init) => {
      const method = String(url).split("/").pop();
      const payload = JSON.parse(init.body);
      calls.push({ method, payload });
      if (method === "getWebhookInfo") {
        return telegramResponse({ url: currentUrl, pending_update_count: 0 });
      }
      if (method === "setWebhook") {
        currentUrl = payload.url;
        return telegramResponse(true);
      }
      throw new Error("unexpected method");
    },
  };

  const result = await ensureTelegramWebhook(env);

  assert.equal(result.status, "configured");
  assert.equal(result.verified, true);
  assert.equal(currentUrl, EXPECTED_WEBHOOK_URL);
  assert.deepEqual(calls.map((call) => call.method), ["getWebhookInfo", "setWebhook", "getWebhookInfo"]);
  assert.equal(calls[1].payload.url, EXPECTED_WEBHOOK_URL);
  assert.equal(calls[1].payload.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
  assert.deepEqual(calls[1].payload.allowed_updates, ["message", "callback_query"]);
  assert.equal(calls[1].payload.drop_pending_updates, false);
});

test("does not call Telegram when required webhook secrets are missing or malformed", async () => {
  let calls = 0;
  const env = {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "contains spaces and is invalid",
    FETCH: async () => { calls += 1; throw new Error("must not call Telegram"); },
  };

  const result = await ensureTelegramWebhook(env);

  assert.equal(result.status, "not_configured");
  assert.equal(calls, 0);
});

test("does not report success when Telegram rejects setWebhook", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123",
    FETCH: async (url, init) => {
      const method = String(url).split("/").pop();
      if (method === "getWebhookInfo") {
        return telegramResponse({ url: "https://old.example/hook" });
      }
      return telegramResponse(false, false);
    },
  };

  const result = await ensureTelegramWebhook(env);

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "set_webhook");
});
