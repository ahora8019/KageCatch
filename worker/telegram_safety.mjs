const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const OPERATOR_PAUSE_UNTIL = 9_007_199_254_740_991;

export function classifyTelegramApiFailure(payload, httpStatus = 0) {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const candidateCode = Number.isSafeInteger(body.error_code) ? body.error_code : httpStatus;
  const errorCode = Number.isSafeInteger(candidateCode) && candidateCode >= 100 && candidateCode <= 599
    ? candidateCode
    : null;

  let kind = "unknown";
  if (errorCode === 429) kind = "rate_limited";
  else if (errorCode === 401) kind = "invalid_credentials";
  else if (errorCode === 403) kind = "access_denied";
  else if (errorCode >= 400 && errorCode < 500) kind = "invalid_request";
  else if (errorCode >= 500 && errorCode < 600) kind = "transient";

  const rawRetryAfter = body.parameters?.retry_after;
  const retryAfterSeconds = kind === "rate_limited"
    && Number.isSafeInteger(rawRetryAfter)
    && rawRetryAfter >= 1
    ? Math.min(rawRetryAfter, MAX_RETRY_AFTER_SECONDS)
    : null;

  return { kind, retryAfterSeconds, errorCode };
}

export class TelegramApiError extends Error {
  constructor(payload, httpStatus = 0) {
    const policy = classifyTelegramApiFailure(payload, httpStatus);
    super("Telegram Bot API request failed (" + (policy.errorCode ?? "unknown") + ")");
    this.name = "TelegramApiError";
    this.kind = policy.kind;
    this.retryAfterSeconds = policy.retryAfterSeconds;
    this.errorCode = policy.errorCode;
  }
}

export class TelegramSafetyGateError extends Error {
  constructor(kind, retryAfterMs = 0) {
    super("Telegram send blocked by safety gate (" + kind + ")");
    this.name = "TelegramSafetyGateError";
    this.kind = kind;
    this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  }
}

export async function acquireTelegramSendPermit(db, now = Date.now(), intervalMs = 100) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  const reserved = await db.prepare(
    "UPDATE telegram_bot_safety SET next_allowed_at_ms = ? + ? WHERE singleton_id = 'control-bot' AND paused_until_ms <= ? AND next_allowed_at_ms <= ? RETURNING next_allowed_at_ms"
  ).bind(now, intervalMs, now, now).first();
  if (reserved) return { allowed: true, retryAfterMs: 0 };

  const state = await db.prepare(
    "SELECT paused_until_ms, next_allowed_at_ms FROM telegram_bot_safety WHERE singleton_id = 'control-bot'"
  ).first();
  if (!state) throw new Error("telegram_safety_state_missing");
  if (state.paused_until_ms > now) {
    if (state.paused_until_ms >= OPERATOR_PAUSE_UNTIL) {
      throw new TelegramSafetyGateError("operator_action_required");
    }
    throw new TelegramSafetyGateError("rate_limited", state.paused_until_ms - now);
  }
  throw new TelegramSafetyGateError("cooldown", state.next_allowed_at_ms - now);
}

export async function waitForTelegramSendPermit(db, intervalMs = 100, maxWaitMs = 1500) {
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    try {
      return await acquireTelegramSendPermit(db, Date.now(), intervalMs);
    } catch (error) {
      if (!(error instanceof TelegramSafetyGateError) || error.kind !== "cooldown") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || error.retryAfterMs > remaining) throw error;
      await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
    }
  }
}

export async function acquireTelegramChatPermit(db, chatId, now = Date.now(), intervalMs = 3100) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  if (!Number.isSafeInteger(chatId) || chatId >= 0) return { allowed: true, retryAfterMs: 0 };
  await db.prepare(
    "INSERT INTO telegram_bot_chat_pacing (chat_id, next_allowed_at_ms) VALUES (?, 0) ON CONFLICT(chat_id) DO NOTHING"
  ).bind(String(chatId)).run();
  const reserved = await db.prepare(
    "UPDATE telegram_bot_chat_pacing SET next_allowed_at_ms = ? + ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND next_allowed_at_ms <= ? RETURNING next_allowed_at_ms"
  ).bind(now, intervalMs, String(chatId), now).first();
  if (reserved) return { allowed: true, retryAfterMs: 0 };
  const state = await db.prepare(
    "SELECT next_allowed_at_ms FROM telegram_bot_chat_pacing WHERE chat_id = ?"
  ).bind(String(chatId)).first();
  if (!state) throw new Error("telegram_chat_pacing_state_missing");
  throw new TelegramSafetyGateError("chat_cooldown", state.next_allowed_at_ms - now);
}

export async function waitForTelegramChatPermit(db, chatId, intervalMs = 3100, maxWaitMs = 4000) {
  if (!Number.isSafeInteger(chatId) || chatId >= 0) return { allowed: true, retryAfterMs: 0 };
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    try {
      return await acquireTelegramChatPermit(db, chatId, Date.now(), intervalMs);
    } catch (error) {
      if (!(error instanceof TelegramSafetyGateError) || error.kind !== "chat_cooldown") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || error.retryAfterMs > remaining) throw error;
      await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
    }
  }
}

export async function recordTelegramApiFailure(db, policy, now = Date.now()) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  if (policy?.kind === "rate_limited") {
    const delayMs = (policy.retryAfterSeconds ?? 60) * 1000;
    await db.prepare(
      "UPDATE telegram_bot_safety SET paused_until_ms = MAX(paused_until_ms, ?), pause_reason = 'telegram_429', updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 'control-bot'"
    ).bind(now + delayMs).run();
  } else if (policy?.kind === "invalid_credentials") {
    await db.prepare(
      "UPDATE telegram_bot_safety SET paused_until_ms = 9223372036854775807, pause_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 'control-bot'"
    ).bind(policy.kind).run();
  }
}
