const QUEUE_PATH = "/internal/panel-requests";
const MAX_QUEUE_BODY_BYTES = 4096;
const PANEL_TTL_MINUTES = 10;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function validPayload(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    && typeof payload.owner_id === "string"
    && /^[1-9][0-9]{0,15}$/.test(payload.owner_id)
    && Number(payload.owner_id) <= 2 ** 52 - 1
    && Number.isSafeInteger(payload.chat_id) && payload.chat_id < 0
    && Number.isSafeInteger(payload.source_message_id) && payload.source_message_id > 0;
}

async function verifySignedRequest(request, env, rawBody) {
  if (!env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32 || !env.CONNECT_LINKS) return 503;
  const timestampRaw = request.headers.get("X-KageCatch-Timestamp") || "";
  const nonce = request.headers.get("X-KageCatch-Nonce") || "";
  const supplied = request.headers.get("X-KageCatch-Signature") || "";
  if (!/^\d{10,12}$/.test(timestampRaw) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) return 401;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestampRaw)) > 60) return 401;
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const path = new URL(request.url).pathname;
  const signingText = [timestampRaw, nonce, request.method, path, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CORE_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingText)));
  const expected = Array.from(expectedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = expected.length ^ supplied.length;
  for (let i = 0; i < expected.length; i += 1) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  if (difference !== 0) return 401;
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const claim = await stub.fetch("https://connect-links.internal/claim-nonce", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, expiresAt: Date.now() + 120000 }),
  });
  if (claim.status === 409) return 409;
  if (!claim.ok) return 503;
  return 200;
}

export async function enqueuePanelRequestAndDispatch(request, env, ctx, sendTelegram) {
  const response = await enqueuePanelRequest(request, env);
  if (response.status !== 202) return response;

  const dispatch = processPanelQueue(env, sendTelegram).catch((error) => {
    console.error(JSON.stringify({
      event: "panel_queue_dispatch_failed",
      error_name: error?.name || "Error",
    }));
    return { processed: 0, error: "dispatch_failed" };
  });

  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(dispatch);
  else await dispatch;
  return response;
}

export async function enqueuePanelRequest(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  if (!env.KAGECATCH_DB) return json({ error: "panel_queue_not_configured" }, 503);
  let rawBody;
  try { rawBody = new Uint8Array(await request.arrayBuffer()); } catch { return json({ error: "invalid_request" }, 400); }
  if (rawBody.byteLength > MAX_QUEUE_BODY_BYTES) return json({ error: "request_too_large" }, 413);
  const auth = await verifySignedRequest(request, env, rawBody);
  if (auth !== 200) return json({ error: auth === 409 ? "request_replayed" : auth === 503 ? "panel_queue_not_configured" : "unauthorized" }, auth);
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { return json({ error: "invalid_request" }, 400); }
  if (!validPayload(payload)) return json({ error: "invalid_panel_request" }, 400);

  const identity = [payload.owner_id, String(payload.chat_id), String(payload.source_message_id)].join(":");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const idempotencyKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const requestId = crypto.randomUUID().replaceAll("-", "");
  try {
    await env.KAGECATCH_DB.prepare(
      "INSERT INTO panel_requests (request_id, idempotency_key, owner_id, chat_id, source_message_id, status, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now', '+10 minutes')) ON CONFLICT(idempotency_key) DO NOTHING"
    ).bind(requestId, idempotencyKey, payload.owner_id, String(payload.chat_id), payload.source_message_id).run();
    const row = await env.KAGECATCH_DB.prepare(
      "SELECT request_id, status FROM panel_requests WHERE idempotency_key = ?"
    ).bind(idempotencyKey).first();
    if (!row) return json({ error: "panel_queue_unavailable" }, 503);
    return json({ accepted: true, request_id: row.request_id, duplicate: row.request_id !== requestId, status: row.status }, 202);
  } catch {
    return json({ error: "panel_queue_unavailable" }, 503);
  }
}

export async function processPanelQueue(env, sendTelegram) {
  if (!env.KAGECATCH_DB || typeof sendTelegram !== "function") return { processed: 0 };
  // Recover claims abandoned by a Worker restart, while bounding retries.
  await env.KAGECATCH_DB.prepare(
    "UPDATE panel_requests SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND updated_at < datetime('now', '-2 minutes') AND attempts < 3"
  ).run();
  await env.KAGECATCH_DB.prepare(
    "UPDATE panel_requests SET status = 'failed', last_error_code = 'delivery_attempts_exhausted', updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND updated_at < datetime('now', '-2 minutes') AND attempts >= 3"
  ).run();
  await env.KAGECATCH_DB.prepare(
    "UPDATE panel_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND expires_at <= CURRENT_TIMESTAMP"
  ).run();
  const rows = await env.KAGECATCH_DB.prepare(
    "SELECT request_id FROM panel_requests WHERE status = 'pending' AND expires_at > CURRENT_TIMESTAMP AND attempts < 3 ORDER BY created_at LIMIT 10"
  ).all();
  let processed = 0;
  for (const item of rows.results || []) {
    const row = await env.KAGECATCH_DB.prepare(
      "UPDATE panel_requests SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP RETURNING request_id, owner_id, chat_id, source_message_id, attempts"
    ).bind(item.request_id).first();
    if (!row) continue;
    try {
      const callback = (action) => "kp:" + row.request_id + ":" + action;
      const sent = await sendTelegram("sendMessage", {
        chat_id: Number(row.chat_id),
        text: "🌸 <b>KageCatch — پنل گروه</b>\n━━━━━━━━━━━━━━\nوضعیت: آماده\nموتور Catch: خاموش\n\nاین پنل فقط برای سازنده قابل کنترل است.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "📊 آمار", callback_data: callback("stats") }, { text: "🎯 موتور Catch", callback_data: callback("engine") }],
          [{ text: "⚙️ تنظیمات", callback_data: callback("settings") }, { text: "🔄 بروزرسانی", callback_data: callback("refresh") }],
          [{ text: "📝 بررسی‌های دستی", callback_data: callback("reviews") }],
          [{ text: "✖️ بستن پنل", callback_data: callback("close") }],
        ] },
      });
      const messageId = sent?.message_id;
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("invalid_telegram_message");
      await env.KAGECATCH_DB.prepare(
        "UPDATE panel_requests SET status = 'completed', panel_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'processing'"
      ).bind(messageId, row.request_id).run();
      processed += 1;
    } catch {
      const nextStatus = row.attempts >= 3 ? "failed" : "pending";
      await env.KAGECATCH_DB.prepare(
        "UPDATE panel_requests SET status = ?, last_error_code = 'telegram_delivery_failed', updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'processing'"
      ).bind(nextStatus, row.request_id).run();
    }
  }
  return { processed };
}

export function parsePanelCallback(data) {
  if (typeof data !== "string") return null;
  const reviewAction = data.match(/^kr:([a-f0-9]{32}):a:(0|[1-9][0-9]?)$/);
  if (reviewAction) return { kind: "review", reviewId: reviewAction[1], action: "approve", candidateIndex: Number(reviewAction[2]) };
  const reviewReject = data.match(/^kr:([a-f0-9]{32}):r$/);
  if (reviewReject) return { kind: "review", reviewId: reviewReject[1], action: "reject" };
  const match = data.match(/^kp:([a-f0-9]{32}):(stats|engine|engine_on|engine_off|settings|refresh|close|reviews)$/);
  return match ? { requestId: match[1], action: match[2] } : null;
}

async function requestCore(env, method, path, payload) {
  if (!env.CORE_API_URL || !env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32) {
    throw new Error("core_api_not_configured");
  }
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signingText = [timestamp, nonce, method, path, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CORE_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingText)));
  const signature = Array.from(signatureBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const fetcher = env.CORE_API_FETCH || fetch;
  const requestInit = {
    method,
    headers: {
      "content-type": "application/json",
      "X-KageCatch-Timestamp": timestamp,
      "X-KageCatch-Nonce": nonce,
      "X-KageCatch-Signature": signature,
    },
  };
  if (method !== "GET" && method !== "HEAD") requestInit.body = body;
  const response = await fetcher(env.CORE_API_URL.replace(/\/$/, "") + path, requestInit);
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.detail || "core_api_request_failed");
  return result;
}

function engineKeyboard(requestId, enabled) {
  return { inline_keyboard: [[
    { text: enabled ? "⏸ خاموش کردن حالت" : "🟢 روشن کردن حالت", callback_data: "kp:" + requestId + (enabled ? ":engine_off" : ":engine_on") },
    { text: "🔄 بروزرسانی", callback_data: "kp:" + requestId + ":engine" },
  ], [{ text: "⚙️ تنظیمات", callback_data: "kp:" + requestId + ":settings" }]] };
}

function engineText(state) {
  return [
    "🎯 کنترل موتور Catch",
    "━━━━━━━━━━━━━━",
    "وضعیت حالت: " + (state.enabled ? "🟢 روشن" : "⚪ خاموش"),
    "موتور اجرایی: " + (state.execution_ready ? "آماده" : "آماده نیست"),
    state.execution_ready
      ? "پردازش رویدادها به خط لولهٔ بررسی متصل است."
      : "تغییر حالت ثبت می‌شود، اما تشخیص و اجرای خودکار تا اتصال کامل موتور فعال نیست.",
  ].join("\n");
}

async function readPanelQueueStats(db) {
  const result = await db.prepare(
    "SELECT status, COUNT(*) AS total FROM panel_requests GROUP BY status"
  ).all();
  const counts = { pending: 0, processing: 0, completed: 0, failed: 0, expired: 0, closed: 0 };
  for (const row of result.results || []) {
    if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.total) || 0;
  }
  return counts;
}

export async function handlePanelCallback(callback, env, telegramApi) {
  const parsed = parsePanelCallback(callback?.data);
  if (!parsed) return false;
  const message = callback.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const actorId = callback.from?.id;
  const deny = async () => telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "⛔ شما به این پنل دسترسی ندارید!",
    show_alert: true,
  });
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || !Number.isSafeInteger(actorId) || !env.KAGECATCH_DB) {
    await deny();
    return true;
  }
  let row;
  try {
    if (parsed.kind === "review") {
      row = await env.KAGECATCH_DB.prepare(
        "SELECT request_id, owner_id, chat_id, panel_message_id, status, expires_at FROM panel_requests WHERE owner_id = ? AND chat_id = ? AND panel_message_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
      ).bind(String(actorId), String(chatId), messageId).first();
    } else {
      row = await env.KAGECATCH_DB.prepare(
        "SELECT request_id, owner_id, chat_id, panel_message_id, status, expires_at FROM panel_requests WHERE request_id = ?"
      ).bind(parsed.requestId).first();
    }
  } catch { row = null; }
  if (!row || String(actorId) !== row.owner_id || String(chatId) !== row.chat_id
    || messageId !== row.panel_message_id || row.status !== "completed"
    || Date.parse(row.expires_at + "Z") <= Date.now()) {
    await deny();
    return true;
  }
  await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id });
  if (parsed.kind === "review") {
    const path = "/v1/reviews/" + row.owner_id + "/" + parsed.reviewId + "/" + parsed.action;
    try {
      const result = await requestCore(
        env, "POST", path,
        parsed.action === "approve" ? { candidate_index: parsed.candidateIndex } : {},
      );
      const status = result.status || "resolved";
      const messageText = parsed.action === "reject"
        ? "🗑️ مورد بررسی رد شد."
        : status === "disabled"
          ? "🛡️ انتخاب انسانی دریافت شد؛ موتور Catch خاموش است و هیچ فرمانی ارسال نشد."
          : status === "adapter_unavailable"
            ? "⚠️ آداپتر مقصد در دسترس نیست؛ هیچ Catch انجام نشد."
            : status === "adapter_mismatch" || status === "media_mismatch"
              ? "⛔ سازگاری منبع یا رسانه تأیید نشد؛ هیچ Catch انجام نشد."
              : "✅ انتخاب انسانی پردازش شد: " + status;
      await telegramApi(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: messageText,
        reply_markup: { inline_keyboard: [[{ text: "↩️ بازگشت به پنل", callback_data: "kp:" + row.request_id + ":refresh" }]] },
      });
    } catch {
      await telegramApi(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: "⚠️ عملیات بررسی انجام نشد؛ ممکن است مورد منقضی یا قبلاً پردازش شده باشد، یا سرویس تأیید هنوز آماده نباشد.",
        reply_markup: { inline_keyboard: [[{ text: "📝 فهرست بررسی‌ها", callback_data: "kp:" + row.request_id + ":reviews" }]] },
      });
    }
    return true;
  }

  if (parsed.action === "close") {
    await env.KAGECATCH_DB.prepare(
      "UPDATE panel_requests SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'completed'"
    ).bind(parsed.requestId).run();
    await telegramApi(env, "editMessageText", {
      chat_id: chatId, message_id: messageId,
      text: "🌸 پنل KageCatch بسته شد.",
    });
    return true;
  }

  let text;
  let replyMarkup;
  if (["engine", "engine_on", "engine_off", "settings"].includes(parsed.action)) {
    try {
      const path = "/v1/accounts/" + row.owner_id + "/catch";
      let state;
      if (parsed.action === "engine_on" || parsed.action === "engine_off") {
        state = await requestCore(env, "PUT", path, { enabled: parsed.action === "engine_on" });
      } else {
        state = await requestCore(env, "GET", path);
      }
      if (parsed.action === "settings") {
        text = [
          "⚙️ وضعیت تنظیمات KageCatch",
          "━━━━━━━━━━━━━━",
          "حالت Catch: " + (state.enabled ? "روشن" : "خاموش"),
          "اتصال حساب: برقرار",
          "موتور اجرایی: " + (state.execution_ready ? "آماده" : "متصل نیست"),
          "تغییرات حالت از Core خوانده می‌شوند.",
        ].join("\n");
        replyMarkup = engineKeyboard(parsed.requestId, state.enabled);
      } else {
        text = engineText(state);
        replyMarkup = engineKeyboard(parsed.requestId, state.enabled);
      }
    } catch {
      text = "⚠️ Core در دسترس نیست یا حساب متصل نیست؛ هیچ تغییری تأیید نشد. کمی بعد دوباره تلاش کن.";
    }
  } else if (parsed.action === "reviews") {
    try {
      const result = await requestCore(env, "GET", "/v1/reviews/" + row.owner_id);
      const items = Array.isArray(result.items) ? result.items.slice(0, 5) : [];
      if (!items.length) {
        text = "📝 بررسی‌های دستی\n━━━━━━━━━━━━━━\nموردی در انتظار تأیید نیست.";
        replyMarkup = { inline_keyboard: [[{ text: "↩️ بازگشت به پنل", callback_data: "kp:" + row.request_id + ":refresh" }]] };
      } else {
        const keyboard = [];
        const sections = [];
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          const anime = String(item.anime_name || "نامشخص").replaceAll(String.fromCharCode(13), " ").replaceAll(String.fromCharCode(10), " ").replaceAll(String.fromCharCode(9), " ").slice(0, 80);
          sections.push((i + 1) + ". " + anime);
          const candidates = Array.isArray(item.candidates) ? item.candidates.slice(0, 10) : [];
          for (let j = 0; j < candidates.length; j += 1) {
            const candidate = String(candidates[j]).replaceAll(String.fromCharCode(13), " ").replaceAll(String.fromCharCode(10), " ").replaceAll(String.fromCharCode(9), " ").slice(0, 48);
            keyboard.push([{ text: "✅ " + candidate, callback_data: "kr:" + item.review_id + ":a:" + j }]);
          }
          keyboard.push([{ text: "❌ رد مورد " + (i + 1), callback_data: "kr:" + item.review_id + ":r" }]);
        }
        text = "📝 بررسی‌های دستی (حداکثر ۵ مورد)\n━━━━━━━━━━━━━━\n" + sections.join("\n") + "\n\nبرای تأیید، شخصیت را انتخاب کن:";
        keyboard.push([{ text: "↩️ بازگشت به پنل", callback_data: "kp:" + row.request_id + ":refresh" }]);
        replyMarkup = { inline_keyboard: keyboard.slice(0, 51) };
      }
    } catch {
      text = "⚠️ دریافت فهرست بررسی‌ها از Core ممکن نشد.";
      replyMarkup = { inline_keyboard: [[{ text: "↩️ بازگشت به پنل", callback_data: "kp:" + row.request_id + ":refresh" }]] };
    }
  } else if (parsed.action === "stats") {
    try {
      const stats = await readPanelQueueStats(env.KAGECATCH_DB);
      const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
      text = [
        "📊 آمار زندهٔ پنل KageCatch",
        "━━━━━━━━━━━━━━",
        `درخواست‌های ثبت‌شده: ${total}`,
        `⏳ در انتظار: ${stats.pending}`,
        `⚙️ در حال پردازش: ${stats.processing}`,
        `✅ تکمیل‌شده: ${stats.completed}`,
        `❌ ناموفق: ${stats.failed}`,
        `⌛ منقضی: ${stats.expired}`,
        `🔒 بسته‌شده: ${stats.closed}`,
      ].join("\n");
    } catch {
      text = "⚠️ دریافت آمار از پایگاه داده ممکن نشد؛ دوباره بروزرسانی کن.";
    }
  } else if (parsed.action === "engine") {
    text = "🎯 موتور Catch\n━━━━━━━━━━━━━━\nوضعیت: خاموش\nارسال زنده فرمان فعال نیست؛ موتور تشخیص و کنترل هنوز متصل نشده و این دکمه موتور را روشن نمی‌کند.";
  } else if (parsed.action === "settings") {
    text = "⚙️ تنظیمات پنل\n━━━━━━━━━━━━━━\nتنظیمات عملیاتی هنوز به ذخیره‌ساز متصل نشده‌اند. هیچ تغییری اعمال نشده است.";
  } else {
    text = "🌸 پنل KageCatch بروزرسانی شد.\nوضعیت موتور Catch: خاموش";
  }
  await telegramApi(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return true;
}
