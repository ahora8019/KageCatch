export const EXPECTED_WEBHOOK_URL = "https://kagecatch-control.ahora-project.workers.dev/webhook";

function isValidSecretToken(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    && /^[A-Za-z0-9_-]+$/.test(value);
}

async function callTelegram(env, method, payload = {}) {
  const requestFetch = env.FETCH || fetch;
  const response = await requestFetch(
    "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  let body;
  try { body = await response.json(); } catch { return { ok: false, result: null }; }
  return { ok: response.ok && body?.ok === true, result: body?.result ?? null };
}

/**
 * Reconcile Telegram's registered webhook with this Worker.
 * Safe to run from the scheduled handler: it preserves queued updates and
 * never reports success until Telegram confirms the configured URL.
 */
export async function ensureTelegramWebhook(env) {
  if (typeof env?.TELEGRAM_BOT_TOKEN !== "string" || !env.TELEGRAM_BOT_TOKEN
    || !isValidSecretToken(env.TELEGRAM_WEBHOOK_SECRET)) {
    return { status: "not_configured" };
  }

  let current;
  try {
    current = await callTelegram(env, "getWebhookInfo");
  } catch {
    return { status: "failed", stage: "get_webhook_info" };
  }
  if (!current.ok || !current.result || typeof current.result.url !== "string") {
    return { status: "failed", stage: "get_webhook_info" };
  }
  if (current.result.url === EXPECTED_WEBHOOK_URL) {
    return { status: "already_configured" };
  }

  try {
    const configured = await callTelegram(env, "setWebhook", {
      url: EXPECTED_WEBHOOK_URL,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    if (!configured.ok || configured.result !== true) {
      return { status: "failed", stage: "set_webhook" };
    }
  } catch {
    return { status: "failed", stage: "set_webhook" };
  }

  try {
    const verified = await callTelegram(env, "getWebhookInfo");
    if (!verified.ok || verified.result?.url !== EXPECTED_WEBHOOK_URL) {
      return { status: "failed", stage: "verify_webhook" };
    }
    return { status: "configured", verified: true };
  } catch {
    return { status: "failed", stage: "verify_webhook" };
  }
}
