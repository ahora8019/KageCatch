const MAX_OWNER_ID = 128;
const MAX_CHAT_ID = 128;
const MAX_REASON = 160;
const MAX_INTERVAL_SECONDS = 60;

function validId(value, maxLength) {
  return (typeof value === "string" || typeof value === "number")
    && String(value).length > 0
    && String(value).length <= maxLength;
}

function unavailable() {
  return { allowed: false, reason: "safety_store_unavailable" };
}

export async function reserveOutbound(env, input = {}) {
  const db = env?.KAGECATCH_DB;
  const { ownerId, chatId, now = Math.floor(Date.now() / 1000), minimumIntervalSeconds = 1 } = input;
  if (!db?.prepare) return unavailable();
  if (!validId(ownerId, MAX_OWNER_ID) || !validId(chatId, MAX_CHAT_ID)
    || !Number.isSafeInteger(now) || now < 0
    || !Number.isInteger(minimumIntervalSeconds)
    || minimumIntervalSeconds < 0 || minimumIntervalSeconds > MAX_INTERVAL_SECONDS) {
    return { allowed: false, reason: "invalid_reservation" };
  }

  const nextAllowedAt = now + minimumIntervalSeconds;
  try {
    const row = await db.prepare(
      `INSERT INTO telegram_send_pacing (owner_id, chat_id, next_allowed_at, updated_at)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM telegram_safety_state
         WHERE owner_id = ? AND security_locked = 0 AND session_revoked = 0
           AND flood_wait_until <= ? AND bot_retry_after <= ?
       )
       ON CONFLICT(owner_id, chat_id) DO UPDATE SET
         next_allowed_at = excluded.next_allowed_at,
         updated_at = excluded.updated_at
       WHERE telegram_send_pacing.next_allowed_at <= ?
       RETURNING next_allowed_at`,
    ).bind(String(ownerId), String(chatId), nextAllowedAt, now,
      String(ownerId), now, now, now).first();

    if (!row) return { allowed: false, reason: "safety_or_pacing_blocked" };
    return { allowed: true, nextAllowedAt: row.next_allowed_at };
  } catch {
    return unavailable();
  }
}

export async function updateTelegramBackoff(env, input = {}) {
  const db = env?.KAGECATCH_DB;
  const { ownerId, kind, until, now = Math.floor(Date.now() / 1000) } = input;
  if (!db?.prepare) return { updated: false, reason: "safety_store_unavailable" };
  if (!validId(ownerId, MAX_OWNER_ID) || !Number.isSafeInteger(until) || until < 0
    || !Number.isSafeInteger(now) || now < 0
    || !["flood_wait", "bot_retry_after"].includes(kind)) {
    return { updated: false, reason: "invalid_backoff" };
  }

  const column = kind === "flood_wait" ? "flood_wait_until" : "bot_retry_after";
  try {
    const result = await db.prepare(
      `UPDATE telegram_safety_state
       SET ${column} = MAX(${column}, ?), updated_at = ?
       WHERE owner_id = ?`,
    ).bind(until, now, String(ownerId)).run();
    return Number(result?.meta?.changes || 0) === 1
      ? { updated: true }
      : { updated: false, reason: "owner_safety_state_missing" };
  } catch {
    return { updated: false, reason: "safety_store_unavailable" };
  }
}

export async function setOwnerSafetyLock(env, input = {}) {
  const db = env?.KAGECATCH_DB;
  const { ownerId, locked, reason = null, now = Math.floor(Date.now() / 1000) } = input;
  if (!db?.prepare) return { updated: false, reason: "safety_store_unavailable" };
  if (!validId(ownerId, MAX_OWNER_ID) || typeof locked !== "boolean"
    || (reason !== null && (typeof reason !== "string" || reason.length > MAX_REASON))
    || !Number.isSafeInteger(now) || now < 0) {
    return { updated: false, reason: "invalid_safety_state" };
  }

  try {
    const row = await db.prepare(
      `INSERT INTO telegram_safety_state
        (owner_id, security_locked, session_revoked, lock_reason, flood_wait_until, bot_retry_after, updated_at)
       VALUES (?, ?, 0, ?, 0, 0, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         security_locked = excluded.security_locked,
         lock_reason = excluded.lock_reason,
         updated_at = excluded.updated_at
       RETURNING owner_id, security_locked, lock_reason`,
    ).bind(String(ownerId), locked ? 1 : 0, locked ? reason : null, now).first();
    return row
      ? { updated: true, locked: row.security_locked === 1, reason: row.lock_reason ?? null }
      : { updated: false, reason: "safety_store_unavailable" };
  } catch {
    return { updated: false, reason: "safety_store_unavailable" };
  }
}
