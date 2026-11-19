const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const OPERATOR_PAUSE_UNTIL = 9_007_199_254_740_991;

// Bot API methods are POSTed by this client. Only known read operations bypass
// the outbound safety gate; new or unknown methods are treated as mutations.
const TELEGRAM_READ_ONLY_METHODS = new Set(["getMe", "getWebhookInfo"]);

export function isTelegramMutatingMethod(method) {
  return typeof method !== "string" || !TELEGRAM_READ_ONLY_METHODS.has(method);
}

export function isValidTelegramMethod(method) {
  return typeof method === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(method);
}

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

export function isTelegramSafetyStop(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  return error instanceof TelegramSafetyGateError
    || error?.kind === "rate_limited"
    || error?.kind === "invalid_credentials"
    || /^telegram_(?:safety|chat_pacing|chat_id)_/.test(message);
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
  const chatKey = Number.isSafeInteger(chatId) && chatId !== 0
    ? String(chatId)
    : typeof chatId === "string" && chatId.trim() && chatId.length <= 128
      ? chatId.trim()
      : null;
  if (!chatKey) throw new Error("telegram_chat_id_invalid");
  await db.prepare(
    "INSERT INTO telegram_bot_chat_pacing (chat_id, next_allowed_at_ms) VALUES (?, 0) ON CONFLICT(chat_id) DO NOTHING"
  ).bind(chatKey).run();
  const reserved = await db.prepare(
    "UPDATE telegram_bot_chat_pacing SET next_allowed_at_ms = ? + ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND next_allowed_at_ms <= ? RETURNING next_allowed_at_ms"
  ).bind(now, intervalMs, chatKey, now).first();
  if (reserved) return { allowed: true, retryAfterMs: 0 };
  const state = await db.prepare(
    "SELECT next_allowed_at_ms FROM telegram_bot_chat_pacing WHERE chat_id = ?"
  ).bind(chatKey).first();
  if (!state) throw new Error("telegram_chat_pacing_state_missing");
  throw new TelegramSafetyGateError("chat_cooldown", state.next_allowed_at_ms - now);
}

export async function waitForTelegramChatPermit(db, chatId, intervalMs = 3100, maxWaitMs = 4000) {
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
      "UPDATE telegram_bot_safety SET paused_until_ms = MAX(paused_until_ms, ?), pause_reason = CASE WHEN paused_until_ms >= 9007199254740991 THEN pause_reason ELSE 'telegram_429' END, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 'control-bot'"
    ).bind(now + delayMs).run();
  } else if (policy?.kind === "invalid_credentials") {
    await db.prepare(
      "UPDATE telegram_bot_safety SET paused_until_ms = 9223372036854775807, pause_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 'control-bot'"
    ).bind(policy.kind).run();
  }
}


const CHAT_CIRCUIT_FAILURE_THRESHOLD = 3;

function normalizeCircuitChatId(chatId) {
  if (Number.isSafeInteger(chatId) && chatId !== 0) return String(chatId);
  if (typeof chatId === "string" && chatId.trim() && chatId.length <= 128) return chatId.trim();
  throw new Error("telegram_chat_id_invalid");
}

export async function assertTelegramChatCircuitClosed(db, chatId) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  const key = normalizeCircuitChatId(chatId);
  const state = await db.prepare(
    "SELECT consecutive_failures, is_open, last_error_code FROM telegram_bot_chat_circuit_breaker WHERE chat_id = ?"
  ).bind(key).first();
  if (state?.is_open === 1 || state?.is_open === true) {
    throw new TelegramSafetyGateError("chat_circuit_open");
  }
  return state ?? { consecutive_failures: 0, is_open: 0, last_error_code: null };
}

export async function recordTelegramChatApiFailure(db, chatId, policy, now = Date.now()) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  if (![400, 403].includes(policy?.errorCode)
    || !["access_denied", "invalid_request"].includes(policy?.kind)) {
    return { recorded: false, opened: false };
  }
  const key = normalizeCircuitChatId(chatId);
  const state = await db.prepare(
    "INSERT INTO telegram_bot_chat_circuit_breaker " +
    "(chat_id, consecutive_failures, is_open, last_error_code, updated_at_ms) " +
    "VALUES (?, 1, 0, ?, ?) " +
    "ON CONFLICT(chat_id) DO UPDATE SET " +
    "consecutive_failures = MIN(telegram_bot_chat_circuit_breaker.consecutive_failures + 1, 3), " +
    "is_open = CASE WHEN MIN(telegram_bot_chat_circuit_breaker.consecutive_failures + 1, 3) >= 3 THEN 1 ELSE telegram_bot_chat_circuit_breaker.is_open END, " +
    "last_error_code = excluded.last_error_code, updated_at_ms = excluded.updated_at_ms " +
    "RETURNING consecutive_failures, is_open"
  ).bind(key, policy.errorCode, now).first();
  if (!state) throw new Error("telegram_chat_circuit_state_missing");
  return {
    recorded: true,
    opened: state.is_open === 1 || state.is_open === true,
    consecutiveFailures: state.consecutive_failures,
  };
}

export async function recordTelegramChatApiSuccess(db, chatId, now = Date.now()) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  const key = normalizeCircuitChatId(chatId);
  const current = await db.prepare(
    "SELECT consecutive_failures, is_open FROM telegram_bot_chat_circuit_breaker WHERE chat_id = ?"
  ).bind(key).first();
  if (current?.is_open === 1 || current?.is_open === true) {
    throw new TelegramSafetyGateError("chat_circuit_open");
  }
  if (current) {
    await db.prepare(
      "UPDATE telegram_bot_chat_circuit_breaker SET consecutive_failures = 0, last_error_code = NULL, updated_at_ms = ? WHERE chat_id = ?"
    ).bind(now, key).run();
  }
  return { reset: Boolean(current) };
}


function numericTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function integerBigInt(value) {
  try {
    const text = String(value ?? 0);
    if (!/^-?\d+$/.test(text)) throw new Error("invalid integer");
    return BigInt(text);
  } catch {
    throw new Error("telegram_safety_state_invalid");
  }
}

export async function getTelegramSafetySnapshot(db, now = Date.now()) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  const globalState = await db.prepare(
    "SELECT paused_until_ms, next_allowed_at_ms, pause_reason, updated_at FROM telegram_bot_safety WHERE singleton_id = 'control-bot'"
  ).first();
  if (!globalState) throw new Error("telegram_safety_state_missing");

  const [pacingResult, circuitResult] = await Promise.all([
    db.prepare(
      "SELECT chat_id, next_allowed_at_ms, updated_at FROM telegram_bot_chat_pacing ORDER BY updated_at DESC LIMIT 100"
    ).all(),
    db.prepare(
      "SELECT chat_id, consecutive_failures, is_open, last_error_code, updated_at_ms FROM telegram_bot_chat_circuit_breaker ORDER BY updated_at_ms DESC LIMIT 100"
    ).all(),
  ]);
  const pacingRows = Array.isArray(pacingResult?.results) ? pacingResult.results : [];
  const circuitRows = Array.isArray(circuitResult?.results) ? circuitResult.results : [];

  const pausedUntil = integerBigInt(globalState.paused_until_ms);
  const nowBigInt = BigInt(Math.max(0, Math.trunc(now)));
  const paused = pausedUntil > nowBigInt;
  const operatorActionRequired = pausedUntil >= BigInt(OPERATOR_PAUSE_UNTIL);
  const storedPauseReason = typeof globalState.pause_reason === "string" ? globalState.pause_reason : null;
  const pauseReason = operatorActionRequired ? "invalid_credentials" : storedPauseReason;
  const globalNextAllowed = numericTimestamp(globalState.next_allowed_at_ms);
  const globalCooldownRemaining = Math.max(0, globalNextAllowed - now);
  const lastErrorCode = operatorActionRequired ? 401 : pauseReason === "telegram_429" ? 429 : null;

  const chats = new Map();
  for (const row of pacingRows) {
    if (row?.chat_id === undefined || row?.chat_id === null) continue;
    const key = String(row.chat_id);
    chats.set(key, {
      chat_id: key,
      next_allowed_at_ms: numericTimestamp(row.next_allowed_at_ms),
      cooldown_remaining_ms: Math.max(0, numericTimestamp(row.next_allowed_at_ms) - now),
      pacing_updated_at: row.updated_at ?? null,
      consecutive_failures: 0,
      is_open: false,
      last_error_code: null,
      circuit_updated_at_ms: null,
    });
  }
  for (const row of circuitRows) {
    if (row?.chat_id === undefined || row?.chat_id === null) continue;
    const key = String(row.chat_id);
    const chat = chats.get(key) || {
      chat_id: key,
      next_allowed_at_ms: 0,
      cooldown_remaining_ms: 0,
      pacing_updated_at: null,
    };
    chat.consecutive_failures = numericTimestamp(row.consecutive_failures);
    chat.is_open = row.is_open === 1 || row.is_open === true;
    chat.last_error_code = Number.isSafeInteger(row.last_error_code) ? row.last_error_code : null;
    chat.circuit_updated_at_ms = numericTimestamp(row.updated_at_ms);
    chat.updated_at = chat.circuit_updated_at_ms
      ? new Date(chat.circuit_updated_at_ms).toISOString()
      : chat.pacing_updated_at;
    chat.cause_of_stop = chat.is_open
      ? "chat_circuit_open"
      : chat.cooldown_remaining_ms > 0
        ? "chat_cooldown"
        : null;
    chats.set(key, chat);
  }
  for (const chat of chats.values()) {
    if (chat.cause_of_stop === undefined) {
      chat.updated_at = chat.pacing_updated_at;
      chat.cause_of_stop = chat.cooldown_remaining_ms > 0 ? "chat_cooldown" : null;
    }
  }

  const retryAfterSeconds = paused && !operatorActionRequired
    ? Number((pausedUntil - nowBigInt + 999n) / 1000n)
    : null;
  const globalCause = paused
    ? operatorActionRequired ? "operator_action_required" : pauseReason || "global_pause"
    : globalCooldownRemaining > 0 ? "global_cooldown" : null;

  return {
    observed_at_ms: now,
    global: {
      paused,
      operator_action_required: paused && operatorActionRequired,
      pause_reason: pauseReason,
      stored_pause_reason: storedPauseReason,
      cause_of_stop: globalCause,
      paused_until_ms: operatorActionRequired ? "9223372036854775807" : String(pausedUntil),
      retry_after_seconds: retryAfterSeconds,
      next_allowed_at_ms: globalNextAllowed,
      cooldown_remaining_ms: globalCooldownRemaining,
      last_error_code: lastErrorCode,
      last_error: lastErrorCode === 401 ? "Telegram Bot API HTTP 401 — invalid credentials" : lastErrorCode === 429 ? "Telegram Bot API HTTP 429 — rate limited" : null,
      updated_at: globalState.updated_at ?? null,
    },
    chats: [...chats.values()].sort((left, right) => {
      const leftTime = left.circuit_updated_at_ms || Date.parse(left.pacing_updated_at || "") || 0;
      const rightTime = right.circuit_updated_at_ms || Date.parse(right.pacing_updated_at || "") || 0;
      return rightTime - leftTime;
    }),
    chats_truncated: pacingRows.length >= 100 || circuitRows.length >= 100,
  };
}

export async function recoverTelegramGlobalPause(db, expectedPausedUntilMs, expectedPauseReason, now = Date.now()) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  const expected = String(expectedPausedUntilMs ?? "");
  if (!/^\d{1,20}$/.test(expected)
    || !["telegram_429", "invalid_credentials"].includes(expectedPauseReason)
    || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("telegram_global_recovery_invalid");
  }
  const recovered = await db.prepare(
    "UPDATE telegram_bot_safety SET paused_until_ms = 0, pause_reason = NULL, updated_at = CURRENT_TIMESTAMP " +
    "WHERE singleton_id = 'control-bot' AND paused_until_ms = CAST(? AS INTEGER) AND pause_reason = ? AND paused_until_ms > ? " +
    "RETURNING singleton_id"
  ).bind(expected, expectedPauseReason, now).first();
  return { recovered: Boolean(recovered), clearedReason: recovered ? expectedPauseReason : null };
}

export async function recoverTelegramChatCircuit(db, chatId, expectedUpdatedAtMs, now = Date.now()) {
  if (!db) throw new Error("telegram_safety_store_unavailable");
  if (!Number.isSafeInteger(expectedUpdatedAtMs) || expectedUpdatedAtMs < 0
    || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("telegram_chat_circuit_recovery_invalid");
  }
  const key = normalizeCircuitChatId(chatId);
  const recovered = await db.prepare(
    "UPDATE telegram_bot_chat_circuit_breaker SET consecutive_failures = 0, is_open = 0, last_error_code = NULL, updated_at_ms = ? " +
    "WHERE chat_id = ? AND is_open = 1 AND updated_at_ms = ? RETURNING chat_id"
  ).bind(now, key, expectedUpdatedAtMs).first();
  return { recovered: Boolean(recovered), chatId: recovered ? key : null };
}
