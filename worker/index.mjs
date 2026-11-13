import { enqueuePanelRequestAndDispatch, processPanelQueue, handlePanelCallback } from "./panel_queue.mjs";
import { normalizeLanguage, translate, languageKeyboard } from "./i18n.mjs";
const WEBHOOK_PATH = "/webhook";
const MAX_BODY_BYTES = 256 * 1024;
const VERSION = "0.9.0";
const CONNECTION_LINK_TTL_SECONDS = 300;
const CONNECTION_LINK_BASE = "https://kagecatch-control.ahora-project.workers.dev";
const PANEL_URL = "https://kagecatch-control.ahora-project.workers.dev/panel";

const RENDER_CORE_HEALTH_URL = "https://kagecatch-core-preview.onrender.com/healthz";

async function keepRenderCoreWarm(env, controller) {
  const requestFetch = env.FETCH || fetch;
  try {
    const response = await requestFetch(RENDER_CORE_HEALTH_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "KageCatch-KeepAlive/1.0",
      },
    });
    const result = { status: response.status, ok: response.ok };
    const log = JSON.stringify({
      event: "render_keepalive",
      target: "kagecatch-core-preview",
      cron: controller?.cron ?? null,
      ...result,
    });
    if (response.ok) console.log(log);
    else console.warn(log);
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      event: "render_keepalive",
      target: "kagecatch-core-preview",
      cron: controller?.cron ?? null,
      status: 0,
      ok: false,
      error: String(error?.message || error),
    }));
    return { status: 0, ok: false };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function verifySecret(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function verifyWebAppInitData(initData, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof initData !== "string" || !initData || initData.length > 8192 || typeof botToken !== "string" || !botToken) return null;
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash");
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) return null;
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > 86400) return null;
  const checkString = entries
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const encoder = new TextEncoder();
  const sourceKey = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secretBytes = await crypto.subtle.sign("HMAC", sourceKey, encoder.encode(botToken));
  const signingKey = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(checkString)));
  const expectedHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = expectedHash.length ^ suppliedHash.length;
  for (let i = 0; i < Math.min(expectedHash.length, suppliedHash.length); i += 1) {
    difference |= expectedHash.charCodeAt(i) ^ suppliedHash.toLowerCase().charCodeAt(i);
  }
  if (difference !== 0) return null;
  let user;
  try { user = JSON.parse(params.get("user") || "null"); } catch { return null; }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  return { user, authDate };
}

async function coreRequest(env, method, path, payload = null) {
  if (!env.CORE_API_URL || !env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32) {
    return { status: 503, data: { error: "core_not_configured" } };
  }
  let base;
  try {
    base = new URL(env.CORE_API_URL);
    if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
      return { status: 503, data: { error: "invalid_core_url" } };
    }
  } catch {
    return { status: 503, data: { error: "invalid_core_url" } };
  }
  const baseUrl = base.href.endsWith("/") ? base.href.slice(0, -1) : base.href;
  const body = payload === null ? "" : JSON.stringify(payload);
  const encoder = new TextEncoder();
  const bodyDigest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  const bodyHash = Array.from(new Uint8Array(bodyDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const signingText = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join("\n");
  const signingKey = await crypto.subtle.importKey("raw", encoder.encode(env.CORE_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(signingText)));
  const signature = Array.from(signatureBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    const requestFetch = env.FETCH || fetch;
    const response = await requestFetch(baseUrl + path, {
      method: method.toUpperCase(),
      headers: {
        "X-KageCatch-Timestamp": timestamp,
        "X-KageCatch-Nonce": nonce,
        "X-KageCatch-Signature": signature,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
    let data;
    try { data = await response.json(); } catch { data = { error: "invalid_core_response" }; }
    return { status: response.status, data };
  } catch {
    return { status: 502, data: { error: "core_unavailable" } };
  }
}

function formatOwnerUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

export function buildOwnerMonitor(monitoring) {
  const available = monitoring?.available === true;
  const keyboard = { inline_keyboard: [
    [{ text: "🔄 Refresh Live Data", callback_data: "owner:monitor:refresh" }],
    [{ text: "🔙 Back to Owner HQ", callback_data: "owner:stats" }],
  ] };
  const lines = available ? [
    "👁️ KAGECATCH | LIVE MONITOR",
    "━━━━━━━━━━━━━━━━━━━━",
    "⚙️ Core: Online",
    "🔄 Panel Queue: " + (Number.isSafeInteger(monitoring.queuePending) ? monitoring.queuePending : "Unavailable") + " pending",
    "👥 Core process count: " + monitoring.activeWorkers + " (this instance only)",
    "🗄️ D1: " + (monitoring.d1Status === "connected" ? "Connected" : "Unavailable"),
    "🔌 Redis: " + (monitoring.redisStatus === "not_configured" ? "Not configured" : monitoring.redisStatus),
    "━━━━━━━━━━━━━━━━━━━━",
    "📋 Recent Events:",
    ...(monitoring.recentEvents.length ? monitoring.recentEvents.map((event) => {
      const time = new Date(event.timestamp * 1000).toISOString().slice(11, 16);
      const level = ["DEBUG", "INFO", "WARN", "WARNING", "ERROR", "CRITICAL"].includes(event.level) ? event.level : "INFO";
      const eventType = typeof event.event_type === "string" && /^[a-z_]{1,40}$/.test(event.event_type) ? event.event_type : "log";
      return "[" + time + "] " + level + " [" + eventType + "]: " + escapeHtml(event.message);
    }) : ["No recent events."]),
    "━━━━━━━━━━━━━━━━━━━━",
  ] : [
    "👁️ KAGECATCH | LIVE MONITOR",
    "━━━━━━━━━━━━━━━━━━━━",
    "🔴 Core Offline",
    "🔄 Queue: Unavailable",
    "👥 Core process count: Unavailable",
    "🗄️ D1: " + (monitoring?.d1Status === "connected" ? "Connected" : "Unavailable"),
    "━━━━━━━━━━━━━━━━━━━━",
    "📋 Recent Events: Unavailable",
  ];
  return { text: "<pre>" + lines.join("\n") + "</pre>", parse_mode: "HTML", keyboard };
}

async function loadOwnerMonitoring(env) {
  const [core, queue] = await Promise.all([
    coreRequest(env, "GET", "/v1/owner/monitoring"),
    (async () => {
      if (!env.KAGECATCH_DB) return { available: false, pending: null };
      try {
        const row = await env.KAGECATCH_DB.prepare(
          "SELECT COUNT(*) AS pending FROM panel_requests WHERE status = 'pending'"
        ).first();
        const pending = Number(row?.pending);
        return Number.isSafeInteger(pending) && pending >= 0
          ? { available: true, pending }
          : { available: false, pending: null };
      } catch {
        return { available: false, pending: null };
      }
    })(),
  ]);
  const data = core.data;
  const valid = core.status >= 200 && core.status < 300
    && data?.core_status === "online"
    && typeof data?.redis_status === "string"
    && Number.isSafeInteger(data?.active_workers) && data.active_workers >= 0
    && Array.isArray(data?.recent_events);
  if (!valid) return { available: false, d1Status: queue.available ? "connected" : "unavailable" };
  const recentEvents = data.recent_events.slice(0, 10).filter((event) =>
    event && Number.isSafeInteger(event.timestamp) && event.timestamp >= 0
    && typeof event.level === "string" && typeof event.message === "string"
    && (event.event_type === undefined || (typeof event.event_type === "string" && /^[a-z_]{1,40}$/.test(event.event_type)))
  );
  return {
    available: true,
    redisStatus: data.redis_status,
    activeWorkers: data.active_workers,
    recentEvents,
    d1Status: queue.available ? "connected" : "unavailable",
    queuePending: queue.pending,
  };
}

export function buildOwnerDashboard(stats) {
  const available = stats?.available === true;
  const keyboard = [
    [
      { text: "👥 Manage Users", callback_data: "owner:members" },
      { text: "📊 System Logs", callback_data: "owner:logs" },
    ],
    [
      { text: "🎯 Catch Engine", callback_data: "owner:catch" },
      { text: "⚙️ Global Settings", callback_data: "owner:global-settings" },
    ],
  ];
  if (available) keyboard.push([{ text: "🔄 Refresh", callback_data: "owner:stats:refresh" }]);
  keyboard.push([{ text: "👁️ Live Monitor", callback_data: "owner:monitor" }]);
  keyboard.push([{ text: "🔙 Back to Main", callback_data: "home:panel" }]);

  const lines = available
    ? [
        "👑 KAGECATCH | OWNER HQ",
        "━━━━━━━━━━━━━━━━━━━━",
        `👥 Total Users: ${stats.totalUsers.toLocaleString("en-US")}`,
        `🟢 Active Sessions: ${stats.activeSessions.toLocaleString("en-US")}`,
        `🎯 Total Catches: ${stats.totalCatches.toLocaleString("en-US")}`,
        `⏱️ System Uptime: ${formatOwnerUptime(stats.uptime)}`,
        "━━━━━━━━━━━━━━━━━━━━",
      ]
    : [
        "👑 KAGECATCH | OWNER HQ",
        "━━━━━━━━━━━━━━━━━━━━",
        stats?.reason === "registry" ? "🔴 Registry Offline" : "🔴 Core Offline",
        "👥 Total Users: Unavailable",
        "🟢 Active Sessions: Unavailable",
        "🎯 Total Catches: Unavailable",
        "⏱️ System Uptime: Unavailable",
        "━━━━━━━━━━━━━━━━━━━━",
      ];

  return {
    text: "<pre>" + lines.join("\n") + "</pre>",
    parse_mode: "HTML",
    keyboard: { inline_keyboard: keyboard },
  };
}

async function loadOwnerStats(env) {
  const [core, registry] = await Promise.all([
    coreRequest(env, "GET", "/v1/owner/stats"),
    registryRequest(env, "/users", {}).then(
      (data) => ({ available: true, data }),
      () => ({ available: false, data: null }),
    ),
  ]);
  const data = core.data;
  const fields = ["total_users", "active_sessions", "total_catches", "system_uptime_seconds"];
  const validCoreStats = core.status >= 200 && core.status < 300 &&
    fields.every((field) => Number.isSafeInteger(data?.[field]) && data[field] >= 0);
  if (!validCoreStats) return { available: false, reason: "core" };
  if (!registry.available || !Array.isArray(registry.data?.users)) {
    return { available: false, reason: "registry" };
  }

  // The Worker registry is authoritative for all invited users, including users
  // who have not connected a Telegram session in Python Core yet.
  const totalUsers = registry.data.users.filter(
    (user) => user && user.role !== "OWNER",
  ).length;

  return {
    available: true,
    totalUsers,
    activeSessions: data.active_sessions,
    totalCatches: data.total_catches,
    uptime: data.system_uptime_seconds,
  };
}

async function loadRuntimeStatus(env, telegramUserId, includeAccountInfo = false) {
  const unavailable = { core: "unavailable", account: "unknown", catchEnabled: null, executionReady: null, accountInfo: null };
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return unavailable;
  const [health, account] = await Promise.all([
    coreRequest(env, "GET", "/v1/health"),
    coreRequest(env, "GET", "/v1/accounts/" + telegramUserId),
  ]);
  const core = health.status >= 200 && health.status < 300
    ? (health.data?.status === "ready" ? "ready" : "degraded")
    : health.status === 503 && health.data?.error === "core_not_configured" ? "not_configured"
      : health.status === 503 ? "degraded" : "unavailable";
  const accountStatus = account.status >= 200 && account.status < 300
    ? account.data?.status : "unknown";
  const result = { core, account: accountStatus, catchEnabled: null, executionReady: null, accountInfo: null };
  if (accountStatus === "connected") {
    const requests = [coreRequest(env, "GET", "/v1/accounts/" + telegramUserId + "/catch")];
    if (includeAccountInfo) requests.push(coreRequest(env, "GET", "/v1/accounts/" + telegramUserId + "/info"));
    const [catcher, info] = await Promise.all(requests);
    if (catcher.status >= 200 && catcher.status < 300) {
      result.catchEnabled = catcher.data?.enabled === true;
      result.executionReady = catcher.data?.execution_ready === true;
    }
    if (includeAccountInfo && info?.status >= 200 && info.status < 300) {
      result.accountInfo = {
        sessionHealth: typeof info.data?.session_health === "string" ? info.data.session_health : "unknown",
        phoneMasked: typeof info.data?.phone_masked === "string" ? info.data.phone_masked : null,
        lastActive: typeof info.data?.last_active === "string" ? info.data.last_active : null,
      };
    }
  }
  return result;
}

async function loadManualReviewPanel(env, telegramUserId, language = "fa") {
  const locale = normalizeLanguage(language);
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
    return { text: "⛔ شناسهٔ کاربر معتبر نیست.", keyboard: backMenu(locale) };
  }
  const response = await coreRequest(env, "GET", "/v1/reviews/" + telegramUserId);
  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data?.items)) {
    return {
      text: locale === "fa"
        ? "🧾 <b>صف بررسی</b>\n\nهستهٔ بررسی در دسترس نیست؛ هیچ عملیاتی انجام نشد."
        : "🧾 <b>Review Queue</b>\n\nReview Core is unavailable. No action was taken.",
      parse_mode: "HTML",
      keyboard: { inline_keyboard: [
        [{ text: translate("common.refresh", locale), callback_data: "catch:reviews" }],
        ...backMenu(locale).inline_keyboard,
      ] },
    };
  }
  const items = response.data.items.slice(0, 5);
  const lines = [
    locale === "fa" ? "🧾 <b>KAGECATCH | صف بررسی</b>" : "🧾 <b>KAGECATCH | REVIEW QUEUE</b>",
    "<code>━━━━━━━━━━━━━━━━━━━━</code>",
  ];
  const keyboard = [];
  if (!items.length) {
    lines.push(locale === "fa" ? "درخواست بررسیِ در انتظاری وجود ندارد." : "There are no pending reviews.");
  }
  for (const item of items) {
    if (!item || !/^[a-f0-9]{32}$/.test(item.review_id) || !Array.isArray(item.candidates)) continue;
    lines.push("<b>" + escapeHtml(item.anime_name || "Unknown") + "</b>");
    lines.push((locale === "fa" ? "شناسه: " : "Review: ") + "<code>" + item.review_id.slice(0, 8) + "</code>");
    if (item.spawn_context_available !== true) {
      lines.push(locale === "fa"
        ? "⚠️ اطلاعات مبدأ کامل نیست؛ تأیید اجرا در دسترس نیست."
        : "⚠️ Origin context is incomplete; execution approval is unavailable.");
    }
    for (let index = 0; index < Math.min(item.candidates.length, 5); index += 1) {
      const candidate = item.candidates[index];
      if (typeof candidate !== "string") continue;
      const label = candidate.length > 40 ? candidate.slice(0, 37) + "…" : candidate;
      keyboard.push([{
        text: (locale === "fa" ? "🔒 " : "🔒 ") + label,
        callback_data: "review:approve:" + item.review_id + ":" + index,
      }]);
    }
    keyboard.push([{
      text: locale === "fa" ? "❌ رد درخواست" : "❌ Reject review",
      callback_data: "review:reject:" + item.review_id,
    }]);
    lines.push("");
  }
  keyboard.push([{ text: translate("common.refresh", locale), callback_data: "catch:reviews" }]);
  keyboard.push(...backMenu(locale).inline_keyboard);
  return { text: lines.join("\n"), parse_mode: "HTML", keyboard: { inline_keyboard: keyboard } };
}

async function miniAppCoreProxy(request, env, action) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_request" }, 400); }
  const verified = await verifyWebAppInitData(body?.initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified) return json({ error: "unauthorized" }, 401);
  let actor;
  try { actor = await getTelegramUser(env, verified.user.id); }
  catch { return json({ error: "identity_service_unavailable" }, 503); }
  const role = resolveRole(verified.user.id, env.OWNER_TELEGRAM_ID, actor?.role, actor?.status);
  if (role === "BLOCKED" || role === "DENIED") return json({ error: "forbidden" }, 403);
  const userId = verified.user.id;
  const accountPath = "/v1/accounts/" + userId;
  const requestSpec = action === "status"
    ? { method: "GET", path: accountPath }
    : action === "connect"
      ? { method: "POST", path: accountPath + "/connect", payload: { phone: body.phone } }
      : action === "connect-code"
        ? { method: "POST", path: accountPath + "/connect/code", payload: { code: body.code } }
        : action === "connect-password"
          ? { method: "POST", path: accountPath + "/connect/password", payload: { password: body.password } }
          : action === "connect-status"
            ? { method: "GET", path: accountPath + "/connect/status" }
            : action === "connect-cancel"
              ? { method: "POST", path: accountPath + "/connect/cancel" }
              : action === "reconnect"
                ? { method: "POST", path: accountPath + "/reconnect" }
                : action === "disconnect"
                  ? { method: "POST", path: accountPath + "/disconnect" }
                  : action === "revoke"
                    ? { method: "DELETE", path: accountPath }
                    : null;
  if (!requestSpec) return json({ error: "unknown_account_action" }, 400);
  const result = await coreRequest(env, requestSpec.method, requestSpec.path, requestSpec.payload ?? null);
  return json(result.data, result.status);
}

async function miniAppSession(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_request" }, 400); }
  const verified = await verifyWebAppInitData(body?.initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified) return json({ error: "unauthorized" }, 401);
  let actor;
  try { actor = await getTelegramUser(env, verified.user.id); }
  catch { return json({ error: "identity_service_unavailable" }, 503); }
  const role = resolveRole(verified.user.id, env.OWNER_TELEGRAM_ID, actor?.role, actor?.status);
  if (role === "BLOCKED" || role === "DENIED") return json({ error: "forbidden" }, 403);
  return json({
    authenticated: true,
    user: {
      id: verified.user.id,
      first_name: typeof verified.user.first_name === "string" ? verified.user.first_name : "",
      username: typeof verified.user.username === "string" ? verified.user.username : null,
    },
    role,
    status: actor?.status ?? "active",
    core_status: "not_connected",
    account_status: "not_connected",
  });
}

async function telegramApi(env, method, payload = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const requestFetch = env.FETCH || fetch;
  const response = await requestFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram API ${method} failed`);
  return result.result;
}

export function buildRoleMenu(role = "MEMBER", language = "fa") {
  const locale = normalizeLanguage(language);
  if (role === "OWNER") return { inline_keyboard: [
    [{ text: "👑 Owner Panel", callback_data: "owner:stats" }],
    [{ text: "👁️ Monitoring", callback_data: "owner:monitor" }, { text: "👥 Members", callback_data: "owner:members" }],
    [{ text: "🎟️ Invites", callback_data: "owner:invites" }, { text: "⚙️ Settings", callback_data: "owner:settings" }],
  ] };
  return { inline_keyboard: [
    [{ text: translate("menu.overview", locale), callback_data: "overview:open" }, { text: translate("menu.catcher", locale), callback_data: "catch:open" }],
    [{ text: translate("menu.settings", locale), callback_data: "settings:open" }, { text: translate("menu.account", locale), callback_data: "account:open" }],
  ] };
}

export function buildMainMenu(language = "fa") { return buildRoleMenu("MEMBER", language); }

export function buildStartMenu(role = "MEMBER", language = "fa") {
  return buildRoleMenu(role, language);
}

export function resolveRole(userId, ownerTelegramId, storedRole = "DENIED", status = "active") {
  if (status === "blocked") return "BLOCKED";
  if (!Number.isSafeInteger(userId)) return "DENIED";
  if (/^\d+$/.test(String(ownerTelegramId || "")) && String(userId) === String(ownerTelegramId)) return "OWNER";
  return storedRole === "MEMBER" ? "MEMBER" : "DENIED";
}
const BACK_MENU = { inline_keyboard: [[{ text: "⬅️ منوی اصلی", callback_data: "menu:main" }]] };

function backMenu(language = "fa") {
  return { inline_keyboard: [[{ text: translate("navigation.back", normalizeLanguage(language)), callback_data: "menu:main" }]] };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]);
}

function runtimeLabels(status = {}, language = "fa") {
  const locale = normalizeLanguage(language);
  const core = translate(status.core === "ready" ? "status.online" : "status." + (status.core || "not_checked"), locale);
  const account = translate("status." + (status.account || "unknown"), locale);
  const catchMode = translate(status.catchEnabled === true ? "status.enabled" : status.catchEnabled === false ? "status.disabled" : "status.unknown", locale);
  const execution = translate(status.executionReady === true ? "status.ready" : status.executionReady === false ? "status.not_ready" : "status.unknown", locale);
  return { core, account, catchMode, execution };
}

export function buildDashboardText(userLabel = "Telegram user", status = {}, language = "fa") {
  const locale = normalizeLanguage(language);
  const labels = runtimeLabels(status, locale);
  return [
    translate("dashboard.title", locale),
    "<code>━━━━━━━━━━━━━━━━━━━━</code>",
    translate("dashboard.user", locale) + ": <b>" + escapeHtml(userLabel) + "</b>",
    translate("dashboard.control", locale) + ": <b>" + translate("status.online", locale) + "</b>",
    translate("dashboard.core", locale) + ": <b>" + labels.core + "</b>",
    translate("dashboard.session", locale) + ": <b>" + labels.account + "</b>",
    translate("dashboard.catch", locale) + ": <b>" + labels.catchMode + "</b>",
    "<code>━━━━━━━━━━━━━━━━━━━━</code>",
    translate("dashboard.select", locale),
  ].join("\n");
}

export function buildCatcherText(status = {}, language = "fa") {
  const locale = normalizeLanguage(language);
  const labels = runtimeLabels(status, locale);
  return [
    translate("catcher.title", locale),
    "<code>━━━━━━━━━━━━━━━━━━━━</code>",
    translate("catcher.account", locale) + ": <b>" + labels.account + "</b>",
    translate("catcher.mode", locale) + ": <b>" + labels.catchMode + "</b>",
    translate("catcher.execution", locale) + ": <b>" + labels.execution + "</b>",
    "<code>━━━━━━━━━━━━━━━━━━━━</code>",
    status.executionReady === true ? translate("catcher.ready", locale) : translate("catcher.not_ready", locale),
  ].join("\n");
}

export function resolveCallback(data, userLabel = "Telegram user", role = "MEMBER", status = {}, language = "fa") {
  const locale = normalizeLanguage(language);
  switch (data) {
    case "language:open":
      return { text: translate("language.title", locale) + "\n\n" + translate("language.description", locale), parse_mode: "HTML", keyboard: languageKeyboard(locale) };
    case "language:selected:fa":
    case "language:selected:en":
      return { text: translate("language.selected." + data.slice("language:selected:".length), locale), keyboard: { inline_keyboard: [[{ text: translate("settings.title", locale).replace(/<[^>]*>/g, ""), callback_data: "settings:open" }], ...backMenu(locale).inline_keyboard] } };
    case "overview:open":
      return {
        text: buildDashboardText(userLabel, status, locale),
        parse_mode: "HTML",
        keyboard: { inline_keyboard: [
          [{ text: translate("overview.stats", locale), callback_data: "stats:open" }],
          [{ text: translate("overview.help", locale), callback_data: "help:open" }],
          ...backMenu(locale).inline_keyboard,
        ] },
      };
    case "account:open":
      return {
        text: translate("account.title", locale) + "\n\n" + translate("account.description", locale),
        parse_mode: "HTML",
        keyboard: { inline_keyboard: [
          [{ text: translate("account.connect", locale), callback_data: "account:connect" }],
          [{ text: translate("account.my_account", locale), callback_data: "account:list" }],
          [{ text: translate("account.security", locale), callback_data: "security:open" }],
          ...backMenu(locale).inline_keyboard,
        ] },
      };
    case "account:connect":
      return {
        text: translate("account.connect", locale) + "\n\n" + translate("account.connect_description", locale),
        keyboard: backMenu(locale),
      };
    case "account:list": {
      const accountInfo = status.accountInfo || {};
      const healthKey = ({ valid: "valid", expired: "expired", revoked: "revoked", unknown: "unknown", not_connected: "not_connected" })[accountInfo.sessionHealth] || "unknown";
      const healthLabel = translate("account." + healthKey, locale);
      const coreOffline = status.core === "unavailable" || status.core === "not_configured";
      const lines = [
        translate("account.details", locale),
        "<code>━━━━━━━━━━━━━━━━━━━━</code>",
        translate("account.session", locale) + ": <b>" + runtimeLabels(status, locale).account + "</b>",
        translate("account.session_health", locale) + ": <b>" + healthLabel + "</b>",
        translate("account.phone", locale) + ": <code>" + escapeHtml(accountInfo.phoneMasked || translate("account.unavailable", locale)) + "</code>",
        translate("account.last_active", locale) + ": <code>" + escapeHtml(accountInfo.lastActive || translate("account.unavailable", locale)) + "</code>",
      ];
      if (coreOffline) lines.push("", "⚠️ " + translate("account.core_offline", locale));
      const keyboard = [];
      if (!coreOffline && status.account !== "connected") {
        keyboard.push([{ text: translate("account.connect", locale), callback_data: "account:connect" }]);
      } else if (!coreOffline && (accountInfo.sessionHealth === "expired" || accountInfo.sessionHealth === "revoked")) {
        keyboard.push([{ text: translate("account.reconnect", locale), callback_data: "account:connect" }]);
      }
      if (!coreOffline) keyboard.push([{ text: translate("account.refresh", locale), callback_data: "account:list" }]);
      keyboard.push([{ text: translate("account.security", locale), callback_data: "security:open" }], ...backMenu(locale).inline_keyboard);
      return { text: lines.join("\n"), parse_mode: "HTML", keyboard: { inline_keyboard: keyboard } };
    }
    case "catch:open":
      return {
        text: buildCatcherText(status, locale),
        parse_mode: "HTML",
        keyboard: { inline_keyboard: [
          [{ text: translate("catcher.bots", locale), callback_data: "bots:open" }],
          [{ text: translate("catcher.reviews", locale), callback_data: "catch:reviews" }],
          [{ text: translate("common.refresh", locale), callback_data: "catch:open" }],
          ...backMenu(locale).inline_keyboard,
        ] },
      };
    case "bots:open":
      return {
        text: translate("bots.title", locale) + "\n\n" + translate("bots.body", locale),
        keyboard: { inline_keyboard: [[{ text: translate("catcher.control", locale), callback_data: "catch:open" }], ...backMenu(locale).inline_keyboard] },
      };
    case "settings:open":
      return {
        text: translate("settings.title", locale) + "\n\n" + translate("settings.description", locale),
        parse_mode: "HTML",
        keyboard: { inline_keyboard: [
          [{ text: translate("settings.language", locale), callback_data: "language:open" }],
          [{ text: translate("settings.security", locale), callback_data: "security:open" }],
          [{ text: translate("settings.help", locale), callback_data: "help:open" }],
          ...backMenu(locale).inline_keyboard,
        ] },
      };
    case "stats:open":
      return { text: translate("stats.title", locale) + "\n\n" + translate("stats.empty", locale), keyboard: backMenu(locale) };
    case "security:open":
      return {
        text: translate("security.title", locale) + "\n\n" + translate("security.body", locale),
        keyboard: backMenu(locale),
      };
    case "account:disconnect":
      return { text: "❌ " + translate("account.not_connected", locale), keyboard: backMenu(locale) };
    case "help:open":
      return {
        text: translate("help.title", locale) + "\n\n" + translate("help.body", locale),
        keyboard: backMenu(locale),
      };
    case "menu:main":
      return { text: translate("menu.welcome", locale) + "\n\n" + translate("menu.choose", locale), keyboard: buildStartMenu(role, locale) };
    default:
      return { text: translate("generic.invalid", locale), keyboard: backMenu(locale), alert: true };
  }
}

export function commandReply(text) {
  const command = (text || "").trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start" || command === "/panel") {
    return {
      text: buildDashboardText(),
      parse_mode: "HTML",
      reply_markup: buildStartMenu(),
    };
  }
  if (command === "/status") {
    return {
      text: "📊 وضعیت KageCatch\n\nControl Worker: فعال\nPython Core: متصل نیست\nاتصال حساب: هنوز فعال نشده\nاجرای Catch: غیرفعال",
    };
  }
  if (command === "/help") {
    return {
      text: "📖 راهنمای KageCatch\n\n🎯 کنترل Catch — وضعیت اجرای خودکار\n🤖 بات‌های مقصد — فهرست مقصدها و فرمان‌ها\n👤 حساب متصل — اتصال و امنیت حساب\n📊 آمار من — آمار تأییدشده\n⚙️ تنظیمات — تنظیمات حساب و Catch\n\n/status — وضعیت سرویس\n/help — راهنما\n/admin — مدیریت مالک.",
      reply_markup: buildMainMenu(),
    };
  }
  if (command === "/admin") {
    return { text: "🔐 بخش مدیریت تا زمان تعریف و تأیید شناسه مالک غیرفعال است." };
  }
  return null;
}

async function manualWebhookSetup(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32) {
    return json({ error: "admin_auth_not_configured" }, 503);
  }
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match || !(await verifySecret(match[1], env.CORE_API_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "telegram_secrets_not_configured" }, 503);
  }
  const expectedUrl = new URL(WEBHOOK_PATH, request.url).toString();
  try {
    const current = await telegramApi(env, "getWebhookInfo");
    if (current.url === expectedUrl) return json({ status: "already_configured", verified: true });
    await telegramApi(env, "setWebhook", {
      url: expectedUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    const verified = await telegramApi(env, "getWebhookInfo");
    if (verified.url !== expectedUrl) return json({ error: "webhook_verification_failed" }, 502);
    return json({ status: "configured", verified: true });
  } catch {
    return json({ error: "telegram_webhook_setup_failed" }, 502);
  }
}

async function health(env) {
  const configured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
  if (!configured) {
    return json({ service: "KageCatch Control", status: "degraded", webhook_auth: Boolean(env.TELEGRAM_WEBHOOK_SECRET), version: VERSION }, 503);
  }
  try {
    const corePromise = env.CORE_API_URL && env.CORE_API_SECRET
      ? coreRequest(env, "GET", "/v1/health")
      : Promise.resolve({ status: 503, data: { status: "not_connected" } });
    const [webhook, bot, core] = await Promise.all([
      telegramApi(env, "getWebhookInfo"),
      telegramApi(env, "getMe"),
      corePromise,
    ]);
    const expectedUrl = new URL(WEBHOOK_PATH, "https://kagecatch-control.ahora-project.workers.dev").toString();
    return json({
      service: "KageCatch Control",
      status: webhook.url === expectedUrl ? "webhook_ready" : "degraded",
      telegram_webhook: webhook.url === expectedUrl ? "configured" : "misconfigured",
      webhook_auth: "enabled",
      bot: { id: bot.id, username: bot.username, first_name: bot.first_name },
      pending_updates: webhook.pending_update_count ?? 0,
      last_telegram_error: webhook.last_error_message ?? null,
      python_core: core.status === 200 && core.data?.status === "ready" ? "connected" : core.status === 503 && core.data?.status === "degraded" ? "degraded" : "unreachable",
      version: VERSION,
    });
  } catch {
    return json({ service: "KageCatch Control", status: "degraded", webhook_auth: "enabled", version: VERSION }, 503);
  }
}

function panelPage() {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const html = `<!doctype html><html lang="fa" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#100e17"><title>KageCatch | Dashboard</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#100e17;color:#f7f0fa;--panel:#1a1722;--line:#382e40;--pink:#ed9dcc;--muted:#a99db0;--green:#82d5ae;--amber:#e8bd75}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 80% 0,#48233e 0,transparent 40%),#100e17}
button{font:inherit;color:inherit;cursor:pointer}.shell{max-width:1380px;margin:auto;padding:calc(22px + env(safe-area-inset-top)) 22px 22px;display:grid;grid-template-columns:230px 1fr;gap:20px}
aside{height:calc(100vh - 44px);min-height:600px;position:sticky;top:22px;background:#1a1722eF;border:1px solid var(--line);border-radius:22px;padding:20px 14px;display:flex;flex-direction:column}
.brand{display:flex;gap:11px;align-items:center;padding:5px 7px 25px}.logo{width:42px;height:42px;border-radius:14px;background:linear-gradient(140deg,#f2b5da,#a96d9e);display:grid;place-items:center;color:#261629;font-size:22px}.brand b{letter-spacing:.12em;font-size:15px}.brand small{display:block;color:var(--muted);font-size:9px;letter-spacing:.16em;margin-top:3px}
.nav-label{color:#796f83;font-size:10px;letter-spacing:.13em;padding:12px}.nav{display:grid;gap:5px}.nav button{background:none;border:1px solid transparent;border-radius:12px;padding:12px;text-align:right;color:#b9adbf;font-size:12px}.nav button.active,.nav button:hover{background:#302438;border-color:#4a364c;color:#ffe4f3}.nav button.active{box-shadow:inset -2px 0 var(--pink)}.profile{margin-top:auto;border-top:1px solid var(--line);padding:16px 8px 0;color:var(--muted);font-size:10px;line-height:1.9}
main{min-width:0}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:4px 0 24px}.eyebrow{font-size:10px;letter-spacing:.16em;color:var(--pink)}h1{font-size:clamp(23px,3vw,32px);margin:7px 0}p{color:var(--muted);font-size:12px;margin:0;line-height:1.9}.pill{border:1px solid #385646;background:#1b2b24;color:var(--green);border-radius:99px;padding:9px 12px;font-size:10px;white-space:nowrap}
.view{display:none}.view.active{display:block}.hero{padding:24px;border:1px solid #583a51;border-radius:20px;background:linear-gradient(115deg,#38243a,#211b2b 75%);margin-bottom:15px;position:relative;overflow:hidden}.hero:after{content:"🌸";position:absolute;left:25px;top:5px;font-size:90px;opacity:.1}.hero h2{font-size:20px;margin:8px 0}.actions{display:flex;gap:9px;margin-top:15px;flex-wrap:wrap}.actions button:disabled{opacity:.45;cursor:not-allowed}#account-login-link{display:inline-block;margin:12px 4px;color:var(--pink);font-size:12px}.primary,.secondary{border-radius:11px;padding:10px 14px;font-size:11px;border:1px solid transparent}.primary{background:var(--pink);color:#291927;font-weight:700}.secondary{background:#ffffff08;border-color:#59455c}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:15px}.stat,.card{background:#1a1722;border:1px solid var(--line);border-radius:16px;padding:16px}.stat label{font-size:10px;color:var(--muted)}.stat strong{display:block;font-size:25px;margin:12px 0 3px}.stat small{font-size:9px;color:#8d8297}
.columns{display:grid;grid-template-columns:1.2fr 1fr;gap:13px}.card h3{font-size:13px;margin:0 0 14px}.service,.target{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#15131c;border:1px solid #302938;border-radius:12px;padding:12px;margin-top:9px}.service b,.target b{display:block;font-size:11px}.service small,.target small{display:block;color:var(--muted);font-size:9px;margin-top:4px}.tag{font-size:9px;border-radius:99px;padding:6px 8px;white-space:nowrap}.ok{background:#1d3028;color:var(--green)}.wait{background:#352b20;color:var(--amber)}.off{background:#30232a;color:#d9a0ad}
.empty{padding:34px 12px;text-align:center;color:var(--muted);font-size:11px;line-height:2}.empty b{display:block;color:#f2e4f4;font-size:13px;margin:8px}.notice{margin-top:13px;padding:13px;background:#241c2b;border:1px solid #4a394e;border-radius:12px;color:#cdbfd1;font-size:10px;line-height:1.9}
footer{display:flex;justify-content:space-between;color:#776d80;font-size:9px;padding:20px 3px}.mobile{display:none}
.skip-link{position:absolute;top:8px;right:8px;z-index:20;transform:translateY(-160%);background:var(--pink);color:#241622;padding:10px 14px;border-radius:10px;font-size:12px;font-weight:700}.skip-link:focus{transform:translateY(0)}
:focus-visible{outline:2px solid #ffd1eb;outline-offset:3px}
.stat,.card{box-shadow:0 10px 30px #00000014;transition:border-color .18s ease,transform .18s ease}
.card:hover,.stat:hover{border-color:#59435a}
.nav button,.mobile button,.primary,.secondary{transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease}
.nav button:active,.mobile button:active,.primary:active,.secondary:active{transform:scale(.98)}
.service,.target{min-height:62px}
.empty{max-width:560px;margin:auto}
#health{display:inline-flex;align-items:center;gap:7px}
#health::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px #ffffff0a}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
@media(max-width:850px){.shell{display:block;padding:15px}aside{display:none}.stats{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}.mobile{display:flex;position:fixed;z-index:5;bottom:calc(9px + env(safe-area-inset-bottom));left:9px;right:9px;justify-content:flex-start;gap:4px;overflow-x:auto;background:#211b2bf2;border:1px solid #4a394e;border-radius:16px;padding:8px;backdrop-filter:blur(16px);scrollbar-width:none}.mobile::-webkit-scrollbar{display:none}.mobile button{flex:1 0 58px;min-width:58px;border:0;background:none;color:#b9adbf;font-size:10px;display:grid;justify-items:center;align-content:center;gap:3px;border-radius:10px;padding:7px 3px}.mobile button.active{color:var(--pink);background:#39283a}main{padding-bottom:124px}}
@media(max-width:480px){.shell{padding:12px}.top{margin:3px 0 15px}.top h1{font-size:22px}.hero{padding:18px}.hero h2{font-size:17px}.stat,.card{padding:13px}.stat strong{font-size:22px}.pill{font-size:9px;padding:8px}}

/* Sakura motion system and secure login dialog */
body{background:radial-gradient(ellipse at 78% -8%,#71365f55 0,transparent 42%),radial-gradient(ellipse at 8% 60%,#342b6340 0,transparent 36%),#100e17;background-size:140% 140%;animation:ambient-drift 22s ease-in-out infinite alternate}
@keyframes ambient-drift{from{background-position:0% 0%,100% 100%,0 0}to{background-position:100% 20%,0% 80%,0 0}}
@keyframes sakura-rise{0%{transform:translate3d(0,18px,0) rotate(-8deg);opacity:0}12%{opacity:.24}88%{opacity:.2}100%{transform:translate3d(26px,-42px,0) rotate(18deg);opacity:0}}
@keyframes panel-enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.view.active{animation:panel-enter .36s cubic-bezier(.2,.75,.25,1) both}.hero:before{content:"✿";position:absolute;right:42%;bottom:-30px;font-size:110px;color:#ffd5ed;opacity:.08;animation:sakura-rise 9s ease-in-out infinite;pointer-events:none}
.login-dialog{width:min(440px,calc(100% - 28px));border:1px solid #75516d;border-radius:24px;padding:0;background:linear-gradient(145deg,#282031,#17141f 75%);color:#f8edf7;box-shadow:0 28px 100px #000b;overflow:hidden}
.login-dialog::backdrop{background:#08060dbb;backdrop-filter:blur(9px)}.login-dialog form{padding:27px}.dialog-mark{width:44px;height:44px;display:grid;place-items:center;border-radius:15px;background:linear-gradient(140deg,#f3b7da,#a96d9e);color:#2a1728;font-size:25px;margin-bottom:18px}.login-dialog h2{font-size:21px;margin:9px 0}.login-dialog p{font-size:12px}.login-label{display:block;margin:22px 0 8px;font-size:11px;color:#e9c5dd}.login-dialog input{width:100%;height:49px;border:1px solid #60465f;border-radius:12px;background:#100e17;color:#fff;padding:0 14px;font:inherit;font-size:15px;direction:ltr;text-align:left;outline:none}.login-dialog input:focus{border-color:#f0a9d1;box-shadow:0 0 0 3px #f0a9d126}.login-feedback{min-height:40px;margin:10px 0;color:#e8b8d5}.dialog-actions{display:flex;gap:10px;margin-top:15px}.dialog-actions button{flex:1}.security-caption{margin-top:18px!important;font-size:10px!important;color:#95869a!important}.login-dialog button:disabled{opacity:.5;cursor:wait}
@media(prefers-reduced-motion:reduce){body,.view.active,.hero:before{animation:none!important}}
</style></head><body>
<a class="skip-link" href="#main-content">رفتن به محتوای اصلی</a><div class="shell"><aside aria-label="ناوبری اصلی">
<div class="brand"><div class="logo">🌸</div><div><b>KAGECATCH</b><small>CONTROL CENTER</small></div></div>
<div class="nav-label">WORKSPACE</div><nav class="nav" aria-label="بخش‌های پنل">
<button class="active" data-view="overview" aria-current="page">⌂　نمای کلی</button><button data-view="accounts">♙　حساب‌های متصل</button><button data-view="catcher">✧　تنظیمات Catch</button><button data-view="activity">◷　تاریخچه عملیات</button><button data-view="security">⬡　امنیت و نشست‌ها</button><button data-view="settings">⚙　تنظیمات</button></nav>
<div class="nav-label">MANAGEMENT</div><nav class="nav"><button data-view="admin" id="admin-nav" hidden>♛　مدیریت سامانه</button></nav>
<div class="profile"><b id="profile-name">حساب تلگرام</b><br><span id="profile-role">برای ورود از داخل بات باز کن</span></div></aside>
<main id="main-content" tabindex="-1"><header class="top"><div><div class="eyebrow">KAGECATCH / DASHBOARD</div><h1 id="title">داشبورد کنترل</h1><p>مرکز مدیریت حساب‌ها و عملیات Catch</p></div><span class="pill" id="health" role="status" aria-live="polite">در حال بررسی اتصال</span></header>
<section class="view active" id="view-overview">
<div class="hero"><div class="eyebrow">WELCOME TO KAGECATCH</div><h2>همه‌چیز برای شروع آماده می‌شود.</h2><p>حساب‌ها، مقصدهای Catch، عملکرد و امنیت نشست‌ها را از یک مرکز مدیریت کن. اتصال حساب و اجرای خودکار پس از راه‌اندازی امن Python Core فعال می‌شود.</p><div class="actions"><button class="primary" data-view="accounts">مدیریت حساب‌ها</button><button class="secondary" data-view="catcher">تنظیمات Catch</button></div></div>
<div class="stats">
<div class="stat"><label>حساب‌های متصل</label><strong>—</strong><small>پس از اتصال Core</small></div>
<div class="stat"><label>Catch امروز</label><strong>—</strong><small>هنوز عملیات زنده ثبت نشده</small></div>
<div class="stat"><label>نرخ موفقیت</label><strong>—</strong><small>نیازمند داده تأییدشده</small></div>
<div class="stat"><label>Python Core</label><strong id="core">Offline</strong><small>اتصال در مرحله بعد</small></div></div>
<div class="columns"><section class="card"><h3>وضعیت اجزای سامانه</h3>
<div class="service"><div><b>Control Worker</b><small>درگاه کنترل تلگرام</small></div><span class="tag wait" id="worker-tag">در حال بررسی</span></div>
<div class="service"><div><b>Python Core</b><small>مدیریت نشست و اجرای Catch</small></div><span class="tag off" id="core-tag" role="status" aria-live="polite">متصل نیست</span></div>
<div class="service"><div><b>Recognition Engine</b><small>تشخیص تصویر و ویدیو</small></div><span class="tag off">در انتظار توسعه</span></div>
<div class="service"><div><b>Catch Engine</b><small>ارسال و تأیید عملیات</small></div><span class="tag wait">آماده‌سازی</span></div></section>
<section class="card"><h3>بات‌های مقصد</h3>
<div class="target"><div><b>HentaCatcherBot</b><small>Image · /catch</small></div><span class="tag ok">پیکربندی‌شده</span></div>
<div class="target"><div><b>Character_Catcher_Bot</b><small>Image · /catch</small></div><span class="tag ok">پیکربندی‌شده</span></div>
<div class="target"><div><b>SenpaiCatcherBot</b><small>Video · /pick</small></div><span class="tag wait">در دسترس · گزارش‌شده</span></div></section></div></section>
<section class="view" id="view-accounts"><div class="card"><h3>حساب‌های تلگرام</h3><div class="empty" id="account-state" aria-live="polite">برای اتصال، ورود امن تلگرام را شروع کن.</div><div class="actions"><button class="primary" id="account-refresh">بررسی وضعیت</button><button class="secondary" id="account-disconnect" disabled>قطع اتصال</button><button class="secondary" id="account-reconnect" disabled>اتصال مجدد</button><button class="secondary" id="account-revoke" disabled>لغو دسترسی</button><button class="primary" id="account-connect">＋ اتصال حساب تلگرام</button></div><div class="notice">شماره، کد یک‌بارمصرف و رمز دومرحله‌ای فقط در فرم امن همین Mini App دریافت می‌شوند. این اطلاعات در چت بات ارسال یا ذخیرهٔ متنی نمی‌شوند.</div></div></section><section class="view" id="view-catcher"><div class="card"><h3>تنظیمات Catch</h3><div class="service"><div><b>حداقل اطمینان تشخیص</b><small>Confidence threshold</small></div><span class="tag wait">قفل‌شده</span></div><div class="service"><div><b>محدودیت عملیات</b><small>Quota per account</small></div><span class="tag wait">قفل‌شده</span></div><div class="service"><div><b>جلوگیری از تکرار</b><small>Duplicate protection</small></div><span class="tag wait">در انتظار Core</span></div><div class="service"><div><b>تأیید نتیجه</b><small>Target response verifier</small></div><span class="tag wait">در انتظار Core</span></div><div class="notice">این تنظیمات تا اتصال Core فقط نمایشی‌اند و هیچ عملیات Catch اجرا نمی‌کنند.</div></div></section>
<section class="view" id="view-activity"><div class="card"><h3>تاریخچه عملیات</h3><div class="empty">◷<b>هنوز رویدادی ثبت نشده است</b>پس از راه‌اندازی Core، نتیجه تأییدشده هر عملیات اینجا نمایش داده می‌شود.</div></div></section>
<section class="view" id="view-security"><div class="card"><h3>امنیت و نشست‌ها</h3><div class="service"><div><b>رمزنگاری Session</b><small>Fernet encryption at rest</small></div><span class="tag wait">نیازمند Core</span></div><div class="service"><div><b>مدیریت نشست‌ها</b><small>قطع و لغو دسترسی</small></div><span class="tag wait">نیازمند Core</span></div><div class="service"><div><b>گزارش دسترسی</b><small>Audit trail</small></div><span class="tag wait">نیازمند Core</span></div><div class="notice">کد ورود، رمز دومرحله‌ای و StringSession از طریق چت بات دریافت نمی‌شوند.</div></div></section>
<section class="view" id="view-settings"><div class="card"><h3>تنظیمات عمومی</h3><div class="empty">⚙<b>تنظیمات هنوز فعال نیستند</b>زبان، اعلان‌ها و ترجیحات Catch پس از احراز هویت Mini App فعال می‌شوند.</div></div></section>
<section class="view" id="view-admin"><div class="card"><h3>مدیریت سامانه</h3><div class="empty">♛<b>بخش مدیریت سامانه</b>هویت مالک از داده امضاشده Telegram و نقش ثبت‌شده در سمت سرور تأیید می‌شود. ابزارهای مدیریت عملیاتی هنوز در حال توسعه‌اند.</div></div></section>
<dialog id="login-dialog" class="login-dialog" aria-labelledby="login-title"><form id="login-form"><div class="dialog-mark">✿</div><div class="eyebrow">SECURE TELEGRAM AUTH</div><h2 id="login-title">اتصال حساب تلگرام</h2><p id="login-description">شماره تلفن را همراه کد کشور وارد کن.</p><label class="login-label" id="login-label" for="login-value">شماره تلفن</label><input id="login-value" name="login-value" type="tel" inputmode="tel" autocomplete="tel" placeholder="+98912…" required maxlength="20"><p id="login-feedback" class="login-feedback" role="status" aria-live="polite"></p><div class="dialog-actions"><button type="button" class="secondary" id="login-cancel">انصراف</button><button type="submit" class="primary" id="login-submit">ارسال کد</button></div><p class="security-caption">🔒 ارتباط رمزنگاری‌شده · اطلاعات ورود در پیام‌های بات دریافت نمی‌شود.</p></form></dialog><footer><span>KageCatch · Control Center</span><span>Worker v0.9.0 · Sakura Control Center</span></footer></main></div>
<nav class="mobile" aria-label="ناوبری موبایل"><button class="active" data-view="overview" aria-current="page">⌂<span>خانه</span></button><button data-view="accounts">♙<span>حساب‌ها</span></button><button data-view="catcher">✧<span>Catch</span></button><button data-view="activity">◷<span>رویدادها</span></button><button data-view="security">⬡<span>امنیت</span></button><button data-view="settings">⚙<span>تنظیمات</span></button><button data-view="admin" id="admin-mobile" hidden>♛<span>مدیریت</span></button></nav>
<script nonce="${nonce}">
const tg=window.Telegram?.WebApp;if(tg){tg.setHeaderColor("#100e17");tg.setBackgroundColor("#100e17");tg.ready();tg.expand();}
let session=null;let authPromise=null;
const titles={overview:"داشبورد کنترل",accounts:"حساب‌های متصل",catcher:"تنظیمات Catch",activity:"تاریخچه عملیات",security:"امنیت و نشست‌ها",settings:"تنظیمات",admin:"مدیریت سامانه"};
function showView(name){if(name==="admin"&&session?.role!=="OWNER"){name="overview";}document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.id==="view-"+name));document.querySelectorAll("nav [data-view]").forEach(x=>{const active=x.dataset.view===name;x.classList.toggle("active",active);if(active)x.setAttribute("aria-current","page");else x.removeAttribute("aria-current");});document.querySelector("#title").textContent=titles[name]||titles.overview;window.scrollTo({top:0,behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});}
document.querySelectorAll("[data-view]").forEach(x=>x.addEventListener("click",()=>showView(x.dataset.view)));
let authFailureMessage="فعلاً نتونستیم وارد پنل بشیم؛ چند لحظه دیگه دوباره تلاش کن.";
async function authenticate(){const name=document.querySelector("#profile-name"),role=document.querySelector("#profile-role"),state=document.querySelector("#account-state");if(!tg?.initData){authFailureMessage="پنل رو از دکمهٔ داخل بات باز کن تا بتونیم حسابت رو بشناسیم.";name.textContent="خوش اومدی!";role.textContent="برای اتصال حساب، پنل رو از داخل بات باز کن.";state.textContent=authFailureMessage;return;}try{const response=await fetch("/api/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({initData:tg.initData}),cache:"no-store"});if(!response.ok){const failure=await response.json().catch(()=>({}));throw Object.assign(new Error(failure.error||"auth"),{status:response.status,code:failure.error});}session=await response.json();authFailureMessage="";name.textContent=session.user.first_name||"دوست KageCatch";role.textContent=session.role==="OWNER"?"مدیر KageCatch":"عضو KageCatch";if(session.role==="OWNER"){document.querySelector("#admin-nav").hidden=false;document.querySelector("#admin-mobile").hidden=false;}refreshAccountStatus();}catch(error){authFailureMessage=error.status===401?"اطلاعات ورود تلگرام تأیید نشد؛ پنل رو کامل ببند و دوباره از بات باز کن.":error.status===403?"این حساب اجازهٔ ورود به پنل رو نداره؛ با مدیر KageCatch تماس بگیر.":error.status===503?"ارتباط پنل با سرویس حساب‌ها برقرار نیست؛ کمی بعد دوباره امتحان کن.":"فعلاً نتونستیم وارد پنل بشیم؛ چند لحظه دیگه دوباره تلاش کن.";name.textContent="یه مشکلی پیش اومد";role.textContent="ورود به پنل کامل نشد.";state.textContent=authFailureMessage;}}
async function accountApi(path,payload={}){if(!tg?.initData||!session)throw Object.assign(new Error("telegram_auth_required"),{status:401});const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({initData:tg.initData,...payload}),cache:"no-store"});const data=await response.json().catch(()=>({error:"invalid_response"}));if(!response.ok)throw Object.assign(new Error(data.error||"core_error"),{status:response.status,data});return data;}
async function refreshAccountStatus(){
  const state=document.querySelector("#account-state");
  const disconnect=document.querySelector("#account-disconnect");
  const reconnect=document.querySelector("#account-reconnect");
  const revoke=document.querySelector("#account-revoke");
  if(!session){state.textContent="برای مشاهده وضعیت، پنل را از داخل بات باز کن.";disconnect.disabled=true;reconnect.disabled=true;revoke.disabled=true;return;}
  state.textContent="در حال بررسی وضعیت حساب…";
  try{
    const data=await accountApi("/api/account/status");
    const connected=data.status==="connected";
    const authorized=data.status==="authorized";
    state.textContent=connected?"حساب تلگرام متصل است":authorized?"نشست مجاز ذخیره شده؛ اتصال فعلی قطع است":data.status==="reauth_required"?"نشست نیازمند ورود دوباره است.":"هنوز حسابی متصل نشده است.";
    disconnect.disabled=!connected;
    reconnect.disabled=!authorized;
    revoke.disabled=!authorized&&!connected;
  }catch(error){
    state.textContent=error.status===503?"الان امکان اتصال نیست؛ یکم بعد دوباره امتحان کن.":error.status===401?"برای ادامه، پنل رو دوباره از داخل بات باز کن.":"نتونستیم وضعیت حسابت رو بگیریم؛ دوباره امتحان کن.";
    disconnect.disabled=true;reconnect.disabled=true;revoke.disabled=true;
  }
}
async function confirmAccountAction(path,message){
  if(!window.confirm(message))return;
  try{
    const result=await accountApi(path);
    document.querySelector("#account-state").textContent=result.status==="revoked"?"دسترسی حساب لغو شد.":result.status==="disconnected"?"اتصال حساب قطع شد.":result.status==="connected"?"حساب دوباره متصل شد.":"عملیات انجام شد.";
    await refreshAccountStatus();
  }catch(error){
    document.querySelector("#account-state").textContent=error.status===503?"هستهٔ اجرایی در دسترس نیست.":"عملیات حساب ناموفق بود.";
  }
}
let loginStage="phone";
function setLoginStage(stage,message=""){
  loginStage=stage;
  const input=document.querySelector("#login-value");
  const label=document.querySelector("#login-label");
  const submit=document.querySelector("#login-submit");
  const description=document.querySelector("#login-description");
  document.querySelector("#login-feedback").textContent=message;
  input.value="";
  if(stage==="phone"){label.textContent="شماره موبایلت";input.type="tel";input.inputMode="tel";input.autocomplete="tel";input.placeholder="+98912…";submit.textContent="ارسال کد";description.textContent="شماره‌ات رو با کد کشور وارد کن تا شروع کنیم.";}
  if(stage==="code"){label.textContent="کد ورود تلگرام";input.type="text";input.inputMode="numeric";input.autocomplete="one-time-code";input.placeholder="کد ارسال‌شده";submit.textContent="تأیید کد";description.textContent="کدی که تلگرام برات فرستاده رو همین‌جا بنویس.";}
  if(stage==="password"){label.textContent="رمز دومرحله‌ای";input.type="password";input.inputMode="text";input.autocomplete="current-password";input.placeholder="رمز 2FA";submit.textContent="تأیید و اتصال";description.textContent="حسابت رمز دومرحله‌ای داره؛ اینجا واردش کن.";}
  input.focus();
}
function openLoginDialog(){
  const dialog=document.querySelector("#login-dialog");
  setLoginStage("phone");
  if(!dialog.open)dialog.showModal();
}
document.querySelector("#login-cancel").addEventListener("click",async()=>{
  try{if(session&&loginStage!=="phone")await accountApi("/api/account/connect/cancel");}catch{}
  document.querySelector("#login-dialog").close();
});
async function connectAccount(){if(!session&&authPromise)await authPromise;if(!session){document.querySelector("#account-state").textContent=authFailureMessage;return;}openLoginDialog();document.querySelector("#login-feedback").textContent="شماره‌ات رو با کد کشور وارد کن تا شروع کنیم."; }
document.querySelector("#login-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  const input=document.querySelector("#login-value");
  const feedback=document.querySelector("#login-feedback");
  const submit=document.querySelector("#login-submit");
  const value=input.value.trim();
  if(!value)return;
  submit.disabled=true;
  feedback.textContent="داریم آماده‌اش می‌کنیم…";
  try{
    let result;
    if(loginStage==="phone"){
      if(!/^\\+[1-9]\\d{7,14}$/.test(value))throw Object.assign(new Error("invalid_phone"),{status:400});
      result=await accountApi("/api/account/connect",{phone:value});
      if(result.status==="already_authorized"){
        await accountApi("/api/account/reconnect");
        document.querySelector("#login-dialog").close();
        await refreshAccountStatus();
        return;
      }
      if(result.status!=="code_sent")throw Object.assign(new Error("code_request_failed"),{status:502});
      setLoginStage("code","کد ورود ارسال شد. کد را فقط همین‌جا وارد کن.");
      return;
    }
    if(loginStage==="code"){
      result=await accountApi("/api/account/connect/code",{code:value});
      if(result.status==="password_required"){
        setLoginStage("password","کد تأیید شد؛ رمز دومرحله‌ای لازم است.");
        return;
      }
    }else if(loginStage==="password"){
      result=await accountApi("/api/account/connect/password",{password:value});
    }
    if(result?.status==="connected"||result?.status==="authorized"){
      document.querySelector("#login-dialog").close();
      document.querySelector("#account-state").textContent="حسابت با موفقیت وصل شد! 🎉";
      await refreshAccountStatus();
      return;
    }
    throw Object.assign(new Error("authorization_incomplete"),{status:502});
  }catch(error){
    feedback.textContent=error.data?.error==="invalid_telegram_code"?"کدی که وارد کردی درست نیست؛ دوباره چکش کن.":error.data?.error==="invalid_2fa_password"?"رمز دومرحله‌ای درست نیست؛ دوباره امتحان کن.":error.message==="invalid_phone"?"شماره رو با کد کشور وارد کن؛ مثل +98912…":error.status===503?"الان امکان اتصال نیست؛ کمی بعد دوباره امتحان کن.":error.status===401?"پنل رو از داخل چت KageCatch باز کن و دوباره تلاش کن.":"اتصال انجام نشد؛ یک بار دیگه امتحان کن.";
    if(loginStage==="password")input.value="";
  }finally{
    submit.disabled=false;
    if(document.querySelector("#login-dialog").open)input.focus();
  }
});
document.querySelector("#account-connect").addEventListener("click",connectAccount);
document.querySelector("#account-refresh").addEventListener("click",refreshAccountStatus);
document.querySelector("#account-reconnect").addEventListener("click",()=>confirmAccountAction("/api/account/reconnect","حساب مجاز دوباره به Telegram متصل شود؟"));
document.querySelector("#account-disconnect").addEventListener("click",()=>confirmAccountAction("/api/account/disconnect","اتصال فعال این حساب قطع شود؟"));
document.querySelector("#account-revoke").addEventListener("click",()=>confirmAccountAction("/api/account/revoke","نشست ذخیره‌شده حذف و دسترسی این حساب لغو شود؟"));
async function refresh(){const pill=document.querySelector("#health"),tag=document.querySelector("#worker-tag");try{const r=await fetch("/health",{cache:"no-store"});const s=await r.json();const ok=r.ok&&s.status==="webhook_ready";pill.textContent=ok?"● Control Plane فعال":"● نیازمند بررسی";pill.style.color=ok?"var(--green)":"var(--amber)";tag.textContent=ok?"فعال":"اختلال";tag.className="tag "+(ok?"ok":"wait");const coreState=s.python_core||"unreachable";document.querySelector("#core").textContent=coreState==="connected"?"Online":coreState==="degraded"?"Degraded":"Offline";const coreTag=document.querySelector("#core-tag");if(coreTag){coreTag.textContent=coreState==="connected"?"متصل":coreState==="degraded"?"دسترسی برقرار · نیازمند پیکربندی":"عدم دسترسی";coreTag.className="tag "+(coreState==="connected"?"ok":coreState==="degraded"?"wait":"off");}}catch{pill.textContent="● عدم دسترسی";tag.textContent="نامشخص";tag.className="tag off";document.querySelector("#core").textContent="Offline";}}
authPromise=authenticate();refresh();
</script></body></html>`;
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self' https://telegram.org 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
  }});
}

export class ConnectionLinkStore {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    const url = new URL(request.url);
    let body;
    try { if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new Error('content type'); body = await request.json(); }
    catch { return json({ error: 'invalid_request' }, 400); }
    if (url.pathname === '/claim-nonce') {
      const { nonce, expiresAt } = body || {};
      if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 180000) return json({ error: 'invalid_request' }, 400);
      const claimed = await this.state.storage.transaction(async (txn) => {
        const prefix = 'internal-nonce:';
        const entries = await txn.list({ prefix, limit: 1000 });
        let cleaned = 0;
        for (const [storedKey, storedExpiry] of entries) {
          if (storedExpiry <= Date.now()) {
            await txn.delete(storedKey);
            cleaned += 1;
            if (cleaned >= 50) break;
          }
        }
        const key = prefix + nonce;
        const existing = await txn.get(key);
        if (existing && existing > Date.now()) return false;
        await txn.put(key, expiresAt);
        return true;
      });
      return claimed ? json({ claimed: true }) : json({ error: 'request_replayed' }, 409);
    }
    if (url.pathname === '/invite/create') {
      const { maxUses, ttlSeconds } = body || {};
      if (![1, 2, 5, 10, 25, 100].includes(maxUses) || ![3600, 86400, 604800].includes(ttlSeconds)) return json({ error: 'invalid_invite_options' }, 400);
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const idBytes = crypto.getRandomValues(new Uint8Array(9));
      const id = Array.from(idBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const record = { id, tokenHash, maxUses, uses: 0, createdAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000, revokedAt: null };
      await this.state.storage.put('invite:' + id, record);
      await this.state.storage.put('invite-token:' + tokenHash, id);
      return json({ token, id, maxUses, expiresIn: ttlSeconds }, 201);
    }
    if (url.pathname === '/invite/list') {
      const entries = await this.state.storage.list({ prefix: 'invite:' });
      const invites = Array.from(entries.values()).map(({ id, maxUses, uses, createdAt, expiresAt, revokedAt }) => ({ id, maxUses, uses, createdAt, expiresAt, revokedAt }));
      invites.sort((a, b) => b.createdAt - a.createdAt);
      return json({ invites: invites.slice(0, 30) });
    }
    if (url.pathname === '/invite/revoke') {
      const id = body?.id;
      if (typeof id !== 'string' || !/^[a-f0-9]{18}$/.test(id)) return json({ error: 'invalid_invite_id' }, 400);
      const key = 'invite:' + id;
      const record = await this.state.storage.get(key);
      if (!record) return json({ error: 'not_found' }, 404);
      if (!record.revokedAt) {
        record.revokedAt = Date.now();
        await this.state.storage.put(key, record);
        await this.state.storage.delete('invite-token:' + record.tokenHash);
      }
      return json({ status: 'revoked' });
    }
    if (url.pathname === '/invite/consume') {
      const { token, telegramUserId } = body || {};
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(token) || !Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return json({ error: 'invalid_invite' }, 400);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const result = await this.state.storage.transaction(async (txn) => {
        const userKey = 'user:' + telegramUserId;
        const existingUser = await txn.get(userKey);
        if (existingUser) return existingUser.status === 'blocked' ? { error: 'blocked' } : { user: existingUser, existing: true };
        const id = await txn.get('invite-token:' + tokenHash);
        if (!id) return { error: 'invalid_or_expired_invite' };
        const inviteKey = 'invite:' + id;
        const invite = await txn.get(inviteKey);
        if (!invite || invite.revokedAt || invite.expiresAt <= Date.now() || invite.uses >= invite.maxUses) return { error: 'invalid_or_expired_invite' };
        const user = { telegramUserId, role: 'MEMBER', status: 'active', createdAt: Date.now(), updatedAt: Date.now(), invitedBy: 'OWNER' };
        invite.uses += 1;
        invite.updatedAt = Date.now();
        await txn.put(inviteKey, invite);
        if (invite.uses >= invite.maxUses) await txn.delete('invite-token:' + tokenHash);
        await txn.put(userKey, user);
        return { user, existing: false };
      });
      if (result.error === 'blocked') return json({ error: 'blocked' }, 403);
      if (result.error) return json({ error: result.error }, 410);
      return json({ user: result.user, existing: result.existing }, 200);
    }
    if (url.pathname === '/register') {
      const { telegramUserId, ownerTelegramId } = body || {};
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return json({ error: 'invalid_request' }, 400);
      const key = 'user:' + telegramUserId;
      const existing = await this.state.storage.get(key);
      const isOwner = /^\d+$/.test(String(ownerTelegramId || '')) && String(telegramUserId) === String(ownerTelegramId);
      const record = existing?.status === 'blocked' && !isOwner
        ? existing
        : { ...existing, telegramUserId, role: isOwner ? 'OWNER' : 'MEMBER', status: 'active', createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
      await this.state.storage.put(key, record);
      return json(record);
    }
    if (url.pathname === '/user') {
      const id = body?.telegramUserId;
      if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'invalid_request' }, 400);
      return json({ user: await this.state.storage.get('user:' + id) || null });
    }
    if (url.pathname === '/language/set') {
      const { telegramUserId, language } = body || {};
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || !['fa', 'en'].includes(language)) return json({ error: 'invalid_language' }, 400);
      const key = 'user:' + telegramUserId;
      const record = await this.state.storage.get(key);
      if (!record) return json({ error: 'user_not_found' }, 404);
      record.language = language;
      record.updatedAt = Date.now();
      await this.state.storage.put(key, record);
      return json({ language: record.language });
    }
    if (url.pathname === '/activity/record') {
      const { telegramUserId, action, firstName, username } = body || {};
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || typeof action !== 'string' || !/^(start|panel|message|command|catch:open|catch:reviews|review:(approve|reject):[a-f0-9:]+|bots:open|account:connect|account:list|stats:open|settings:open|security:open|account:disconnect|help:open|owner:[a-z0-9:_-]+|home:[a-z]+)$/.test(action)) return json({ error: 'invalid_activity' }, 400);
      const key = 'user:' + telegramUserId;
      const existing = await this.state.storage.get(key);
      if (!existing) return json({ error: 'user_not_found' }, 404);
      const now = Date.now();
      const event = { at: now, action };
      const events = Array.isArray(existing.recentActivity) ? existing.recentActivity : [];
      existing.lastSeenAt = now;
      existing.lastAction = action;
      existing.recentActivity = [event, ...events].slice(0, 10);
      if (typeof firstName === 'string') existing.firstName = firstName.slice(0, 64);
      if (typeof username === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(username)) existing.username = username;
      await this.state.storage.put(key, existing);
      return json({ recorded: true, lastSeenAt: now });
    }
    if (url.pathname === '/activity/list') {
      const id = body?.telegramUserId;
      if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'invalid_request' }, 400);
      const user = await this.state.storage.get('user:' + id);
      return json({ events: Array.isArray(user?.recentActivity) ? user.recentActivity : [] });
    }
    if (url.pathname === '/users') {
      const entries = await this.state.storage.list({ prefix: 'user:' });
      return json({ users: Array.from(entries.values()) });
    }
    if (url.pathname === '/manage-user') {
      const { telegramUserId, action } = body || {};
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || !['block','unblock'].includes(action)) return json({ error: 'invalid_request' }, 400);
      const key = 'user:' + telegramUserId;
      const record = await this.state.storage.get(key);
      if (!record) return json({ error: 'not_found' }, 404);
      if (record.role === 'OWNER') return json({ error: 'owner_protected' }, 403);
      record.status = action === 'block' ? 'blocked' : 'active';
      record.updatedAt = Date.now();
      await this.state.storage.put(key, record);
      return json(record);
    }
    if (url.pathname === '/broadcast') {
      const { ownerTelegramId, action, text } = body || {};
      if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0 || !['begin','get','save','claim','clear'].includes(action)) return json({ error: 'invalid_request' }, 400);
      const key = 'broadcast:' + ownerTelegramId;
      if (action === 'begin') {
        await this.state.storage.put(key, { status: 'awaiting_text', text: null, updatedAt: Date.now() });
        return json({ status: 'awaiting_text' });
      }
      if (action === 'get') return json({ draft: await this.state.storage.get(key) || null });
      if (action === 'clear') {
        await this.state.storage.delete(key);
        return json({ status: 'cleared' });
      }
      if (action === 'save') {
        if (typeof text !== 'string' || !text.trim() || text.length > 4096) return json({ error: 'invalid_broadcast_text' }, 400);
        const current = await this.state.storage.get(key);
        if (!current || current.status !== 'awaiting_text') return json({ error: 'no_broadcast_draft' }, 409);
        const draft = { status: 'awaiting_confirmation', text, updatedAt: Date.now() };
        await this.state.storage.put(key, draft);
        return json(draft);
      }
      if (action === 'claim') {
        const draft = await this.state.storage.transaction(async (txn) => {
          const current = await txn.get(key);
          if (!current || current.status !== 'awaiting_confirmation') return null;
          await txn.put(key, { ...current, status: 'sending', updatedAt: Date.now() });
          return current;
        });
        return draft ? json({ draft }) : json({ error: 'no_confirmable_broadcast' }, 409);
      }
    }
    if (url.pathname === '/create') {
      const { telegramUserId, ttlSeconds } = body || {};
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 600) return json({ error: 'invalid_request' }, 400);
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      await this.state.storage.put(key, { telegramUserId, expiresAt: Date.now() + ttlSeconds * 1000 });
      return json({ token, expiresIn: ttlSeconds }, 201);
    }
    if (url.pathname === '/consume') {
      const token = body?.token;
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(token)) return json({ error: 'invalid_link' }, 400);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const sessionToken = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const sessionDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionToken));
      const sessionKey = 'browser:' + Array.from(new Uint8Array(sessionDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const record = await this.state.storage.transaction(async (txn) => {
        const value = await txn.get(key);
        if (!value) return null;
        await txn.delete(key);
        if (value.expiresAt <= Date.now()) return null;
        await txn.put(sessionKey, { telegramUserId: value.telegramUserId, expiresAt: Date.now() + 10 * 60 * 1000 });
        return value;
      });
      if (!record) return json({ error: 'invalid_or_expired_link' }, 410);
      return json({ sessionToken, expiresIn: 600 }, 200);
    }
    if (url.pathname === '/browser-session') {
      const sessionToken = body?.sessionToken;
      if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(sessionToken)) return json({ error: 'invalid_session' }, 401);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionToken));
      const key = 'browser:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const record = await this.state.storage.get(key);
      if (!record || record.expiresAt <= Date.now()) {
        if (record) await this.state.storage.delete(key);
        return json({ error: 'invalid_or_expired_session' }, 401);
      }
      return json({ telegramUserId: record.telegramUserId }, 200);
    }
    return json({ error: 'not_found' }, 404);
  }
}

async function createConnectionLink(env, telegramUserId) {
  if (!env.CONNECT_LINKS) throw new Error('CONNECT_LINKS binding is not configured');
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName('connection-links-v1'));
  const response = await stub.fetch('https://connect-links.internal/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ telegramUserId, ttlSeconds: CONNECTION_LINK_TTL_SECONDS }) });
  if (!response.ok) throw new Error('Connection link service unavailable');
  const result = await response.json();
  return CONNECTION_LINK_BASE + '/connect/' + encodeURIComponent(result.token);}

async function registryRequest(env, path, payload) {
  if (!env.CONNECT_LINKS) throw new Error('User registry unavailable');
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName('connection-links-v1'));
  const response = await stub.fetch('https://connect-links.internal' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) { const error = new Error('User registry unavailable'); error.status = response.status; throw error; }
  return response.json();
}

async function getTelegramUser(env, userId) {
  const result = await registryRequest(env, '/user', { telegramUserId: userId });
  return result.user;
}


function activityLabel(action) {
  const labels = {
    start: "شروع بات", panel: "باز کردن پنل", message: "ارسال پیام (بدون ذخیره متن)", command: "اجرای دستور",
    "catch:open": "ورود به کنترل Catch", "catch:reviews": "مشاهده صف بررسی",
    "bots:open": "مشاهده بات‌های مقصد", "account:connect": "اتصال حساب تلگرام",
    "account:list": "مشاهده حساب متصل", "stats:open": "مشاهده آمار", "settings:open": "باز کردن تنظیمات",
    "security:open": "مشاهده امنیت حساب", "account:disconnect": "قطع اتصال حساب", "help:open": "مشاهده راهنما",
    "home:panel": "بازگشت به پنل کاربری", "home:admin": "باز کردن پنل Owner", "owner:monitor": "باز کردن نظارت کاربران",
    "owner:invites": "مدیریت دعوت‌ها", "owner:members": "مدیریت اعضا", "owner:stats": "مشاهده نمای کلی",
  };
  if (labels[action]) return labels[action];
  if (action.startsWith("owner:invite:create:")) return "ساخت لینک دعوت";
  if (action.startsWith("owner:invite:revoke:")) return "لغو لینک دعوت";
  if (action.startsWith("owner:monitor:user:")) return "مشاهده جزئیات عضو";
  if (action.startsWith("owner:block:")) return "مسدودسازی عضو";
  if (action.startsWith("owner:unblock:")) return "رفع مسدودی عضو";
  return action.startsWith("owner:") ? "فعالیت مدیریتی" : action;
}

async function handleOwnerCallback(callback, env) {
  const data = callback.data || '';
  if (data === 'owner:logs') {
    const { users = [] } = await registryRequest(env, '/users', {});
    const events = users.flatMap((user) =>
      (Array.isArray(user.recentActivity) ? user.recentActivity : []).map((event) => ({
        at: event.at,
        action: event.action,
        user: user.firstName || (user.username ? '@' + user.username : String(user.telegramUserId)),
      })),
    ).sort((a, b) => b.at - a.at).slice(0, 12);
    const history = events.map((event) =>
      '• ' + new Date(event.at).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) +
      ' — ' + event.user + ' — ' + activityLabel(event.action)
    ).join('\n') || 'هنوز رویدادی ثبت نشده است.';
    return {
      text: '📊 SYSTEM LOGS\n\n' + history,
      keyboard: { inline_keyboard: [[{ text: '👑 Owner HQ', callback_data: 'owner:stats' }], ...BACK_MENU.inline_keyboard] },
    };
  }
  if (data === 'owner:catch') return {
    text: '🎯 CATCH ENGINE\n\n🔴 Live execution: Disabled\nVerified catches: 0\n\nCatch execution and persistent verified-result tracking are not connected yet. No live action was started.',
    keyboard: { inline_keyboard: [[{ text: '👑 Owner HQ', callback_data: 'owner:stats' }], ...BACK_MENU.inline_keyboard] },
  };
  if (data === 'owner:global-settings') return {
    text: '⚙️ GLOBAL SETTINGS\n\nRead-only preview. Global configuration changes are not enabled in this release.',
    keyboard: { inline_keyboard: [[{ text: '👑 Owner HQ', callback_data: 'owner:stats' }], ...BACK_MENU.inline_keyboard] },
  };
  if (data === 'owner:members:monitor') {
    const { users = [] } = await registryRequest(env, '/users', {});
    const members = users.filter((user) => user.role !== 'OWNER').sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0)).slice(0, 12);
    const statuses = await Promise.all(members.map(async (user) => {
      const result = await coreRequest(env, 'GET', '/v1/accounts/' + user.telegramUserId);
      return { user, account: result.status >= 200 && result.status < 300 ? result.data : null };
    }));
    const lines = statuses.map(({ user, account }) => {
      const name = user.firstName || (user.username ? '@' + user.username : 'کاربر ' + user.telegramUserId);
      const accountLabel = !account ? '⚪ وضعیت حساب نامشخص (Core در دسترس نیست)' : account.connected ? '🟢 کلاینت تلگرام در Core فعال است' : account.session_saved ? '🟡 نشست مجاز ذخیره است؛ کلاینت اجرا نیست' : '🔴 حساب متصل نیست';
      const seen = user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) : 'هنوز فعالیتی ثبت نشده';
      const action = user.lastAction ? activityLabel(user.lastAction) : '—';
      return '👤 ' + name + '\n' + accountLabel + '\n🕒 آخرین فعالیت: ' + seen + '\n⚡ آخرین بخش: ' + action;
    });
    const rows = members.map((user) => [{ text: 'جزئیات ' + (user.firstName || user.telegramUserId), callback_data: 'owner:members:monitor:user:' + user.telegramUserId }]);
    rows.push([{ text: '🔄 بروزرسانی', callback_data: 'owner:members:monitor' }, { text: '⬅️ پنل Owner', callback_data: 'home:admin' }]);
    return { text: '👁️ نظارت کاربران KageCatch\n\n' + (lines.join('\n\n') || 'هنوز عضوی وجود ندارد.') + '\n\nاین وضعیت، فعال‌بودن کلاینت در Core را نشان می‌دهد؛ ذخیره‌بودن نشست به‌تنهایی به معنی اجرای کلاینت نیست.', keyboard: { inline_keyboard: rows } };
  }
  const monitorUser = data.match(/^owner:members:monitor:user:(\d+)$/);
  if (monitorUser) {
    const telegramUserId = Number(monitorUser[1]);
    const { users = [] } = await registryRequest(env, '/users', {});
    const user = users.find((item) => item.telegramUserId === telegramUserId);
    if (!user) return { text: 'این کاربر پیدا نشد.', keyboard: BACK_MENU, alert: true };
    const status = await coreRequest(env, 'GET', '/v1/accounts/' + telegramUserId);
    const { events = [] } = await registryRequest(env, '/activity/list', { telegramUserId });
    const account = status.status >= 200 && status.status < 300 ? status.data : null;
    const state = !account ? 'نامشخص؛ Core در دسترس نیست' : account.connected ? 'کلاینت تلگرام در Core فعال است' : account.session_saved ? 'نشست مجاز ذخیره شده، اما کلاینت اجرا نیست' : 'متصل نیست';
    const history = events.map((event) => '• ' + new Date(event.at).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) + ' — ' + activityLabel(event.action)).join('\n') || 'رویدادی ثبت نشده است.';
    return { text: '👤 جزئیات کاربر\n\nشناسه: ' + telegramUserId + '\nنام: ' + (user.firstName || 'ثبت نشده') + '\nنام کاربری: ' + (user.username ? '@' + user.username : 'ثبت نشده') + '\nوضعیت دسترسی: ' + user.status + '\nوضعیت حساب: ' + state + '\nنشست ذخیره‌شده: ' + (account ? (account.session_saved ? 'بله' : 'خیر') : 'نامشخص') + '\n\n📜 آخرین فعالیت‌ها\n' + history, keyboard: { inline_keyboard: [[{ text: '⬅️ بازگشت به نظارت', callback_data: 'owner:members:monitor' }], ...BACK_MENU.inline_keyboard] } };
  }
  if (data === 'owner:invites') {
    const { invites = [] } = await registryRequest(env, '/invite/list', {});
    const usable = invites.filter((invite) => !invite.revokedAt && invite.expiresAt > Date.now() && invite.uses < invite.maxUses);
    const lines = usable.slice(0, 10).map((invite) => '• ' + invite.id.slice(0, 8) + ' — ' + invite.uses + '/' + invite.maxUses + ' استفاده');
    const revokeRows = usable.slice(0, 10).map((invite) => [{ text: 'لغو دعوت ' + invite.id.slice(0, 6), callback_data: 'owner:invite:revoke:' + invite.id }]);
    return { text: '🎟️ مدیریت دعوت‌ها\n\nدعوت جدید بساز و لینک رو برای کاربر بفرست. لینک‌ها تعداد استفاده و تاریخ انقضا دارن.\n\nدعوت‌های فعال:\n' + (lines.join('\n') || 'دعوت فعالی وجود نداره.'), keyboard: { inline_keyboard: [[{ text: '＋ دعوت ۱ نفره · ۲۴ ساعت', callback_data: 'owner:invite:create:1' }, { text: '＋ دعوت ۱۰ نفره · ۷ روز', callback_data: 'owner:invite:create:10' }], ...revokeRows, [{ text: '⬅️ پنل Owner', callback_data: 'home:admin' }]] } };
  }
  const createInviteMatch = data.match(/^owner:invite:create:(1|10)$/);
  if (createInviteMatch) {
    const maxUses = Number(createInviteMatch[1]);
    const ttlSeconds = maxUses === 1 ? 86400 : 604800;
    const invite = await registryRequest(env, '/invite/create', { maxUses, ttlSeconds });
    const link = 'https://t.me/KageCatchBot?start=inv_' + invite.token;
    const duration = maxUses === 1 ? '۲۴ ساعت' : '۷ روز';
    return { text: '✅ لینک دعوت ساخته شد\n\nظرفیت: ' + maxUses + ' نفر\nاعتبار: ' + duration + '\n\n' + link + '\n\nاین لینک رو فقط برای افراد مورداعتماد بفرست.', keyboard: { inline_keyboard: [[{ text: '🔗 باز کردن لینک دعوت', url: link }], [{ text: '🎟️ مدیریت دعوت‌ها', callback_data: 'owner:invites' }], ...BACK_MENU.inline_keyboard] } };
  }
  const revokeInviteMatch = data.match(/^owner:invite:revoke:([a-f0-9]{18})$/);
  if (revokeInviteMatch) {
    await registryRequest(env, '/invite/revoke', { id: revokeInviteMatch[1] });
    return { text: '🗑️ لینک دعوت لغو شد و دیگه قابل استفاده نیست.', keyboard: { inline_keyboard: [[{ text: '🎟️ مدیریت دعوت‌ها', callback_data: 'owner:invites' }], ...BACK_MENU.inline_keyboard] } };
  }
  if (data === 'owner:settings') return {
    text: '⚙️ تنظیمات Owner\n\nتغییرات عملیاتی تا اتصال و تأیید Python Core غیرفعال‌اند.',
    keyboard: { inline_keyboard: [
      [{ text: '📣 پیام همگانی', callback_data: 'owner:broadcast' }],
      [{ text: '🛑 توقف اضطراری', callback_data: 'owner:emergency' }],
      [{ text: '🧩 پنل کاربری', callback_data: 'home:panel' }],
      ...BACK_MENU.inline_keyboard,
    ] },
  };
  if (data === 'owner:broadcast') {
    await registryRequest(env, '/broadcast', { ownerTelegramId: callback.from.id, action: 'begin' });
    return { text: '📣 پیام همگانی\n\nمتن پیام را در همین چت بفرست. قبل از ارسال، پیش‌نمایش می‌بینی و باید تأیید کنی.', keyboard: { inline_keyboard: [[{ text: 'لغو', callback_data: 'owner:broadcast:cancel' }]] } };
  }
  if (data === 'owner:broadcast:cancel') {
    await registryRequest(env, '/broadcast', { ownerTelegramId: callback.from.id, action: 'clear' });
    return { text: 'ارسال همگانی لغو شد.', keyboard: BACK_MENU };
  }
  if (data === 'owner:broadcast:confirm') {
    const claimed = await registryRequest(env, '/broadcast', { ownerTelegramId: callback.from.id, action: 'claim' });
    const messageText = claimed.draft?.text;
    if (typeof messageText !== 'string') return { text: 'پیش‌نویس معتبری برای ارسال وجود ندارد.', keyboard: BACK_MENU, alert: true };
    const { users = [] } = await registryRequest(env, '/users', {});
    const recipients = users.filter((user) => user.role === 'MEMBER' && user.status === 'active' && Number.isSafeInteger(user.telegramUserId));
    let delivered = 0; let failed = 0;
    for (const recipient of recipients) {
      try { await telegramApi(env, 'sendMessage', { chat_id: recipient.telegramUserId, text: messageText }); delivered += 1; }
      catch { failed += 1; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await registryRequest(env, '/broadcast', { ownerTelegramId: callback.from.id, action: 'clear' });
    return { text: '📣 ارسال همگانی تمام شد.\n\nموفق: ' + delivered + '\nناموفق: ' + failed + '\nمخاطبان فعال: ' + recipients.length, keyboard: BACK_MENU };
  }
  if (data === 'owner:emergency') return { text: '🛑 توقف اضطراری\n\nCatch در حال حاضر فعال نیست؛ هیچ عملیات زنده‌ای برای توقف وجود ندارد.', keyboard: BACK_MENU };
  if (data === 'owner:members') {
    const result = await registryRequest(env, '/users', {});
    const users = result.users || [];
    const lines = users.map((u) => '• ' + u.telegramUserId + ' — ' + u.role + ' — ' + u.status);
    const keyboard = users.filter((u) => u.role !== 'OWNER').slice(0, 20).map((u) => [{ text: (u.status === 'blocked' ? '🔓 آزادسازی ' : '🚫 مسدودسازی ') + u.telegramUserId, callback_data: 'owner:' + (u.status === 'blocked' ? 'unblock:' : 'block:') + u.telegramUserId }]);
    keyboard.unshift([{ text: '👁️ نظارت نشست اعضا', callback_data: 'owner:members:monitor' }]);
    keyboard.push([{ text: '⬅️ پنل Owner', callback_data: 'home:admin' }]);
    return { text: '👥 اعضای KageCatch\n\n' + (lines.join('\n') || 'هنوز عضوی ثبت نشده است.'), keyboard: { inline_keyboard: keyboard } };
  }
  const manage = data.match(/^owner:(block|unblock):(\d+)$/);
  if (manage) {
    const telegramUserId = Number(manage[2]);
    if (!Number.isSafeInteger(telegramUserId)) return { text: 'شناسه عضو معتبر نیست.', keyboard: BACK_MENU, alert: true };
    const result = await registryRequest(env, '/manage-user', { telegramUserId, action: manage[1] });
    return { text: 'وضعیت عضو ' + telegramUserId + ' به‌روزرسانی شد: ' + result.status, keyboard: BACK_MENU };
  }
  return { text: 'گزینه مدیریتی نامعتبر است.', keyboard: BACK_MENU, alert: true };
}

async function handleCallback(callback, env) {
  const isOwnerCallback = callback.data?.startsWith("owner:");
  const configuredOwnerId = String(env.OWNER_TELEGRAM_ID || "");
  const ownerTelegramId = /^[1-9]\d*$/.test(configuredOwnerId)
    ? Number(configuredOwnerId)
    : NaN;
  const isExactOwner =
    Number.isSafeInteger(ownerTelegramId) &&
    Number.isSafeInteger(callback.from?.id) &&
    callback.from.id === ownerTelegramId;
  if (isOwnerCallback && !isExactOwner) {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "⛔ Unauthorized",
      show_alert: true,
    });
    return;
  }
  if (await handlePanelCallback(callback, env, telegramApi)) return;
  const chat = callback.message?.chat;
  if (chat?.type !== "private" || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(callback.from?.id)) {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "این بخش فقط در گفت‌وگوی خصوصی در دسترس است.", show_alert: true });
    return;
  }
  const actor = await getTelegramUser(env, callback.from.id);
  const role = resolveRole(callback.from.id, env.OWNER_TELEGRAM_ID, actor?.role, actor?.status);
  let locale = normalizeLanguage(actor?.language);
  if (role === 'BLOCKED' || role === 'DENIED') {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "⛔ دسترسی شما مجاز نیست.", show_alert: true });
    return;
  }
  if (callback.data?.startsWith('owner:') && role !== 'OWNER') {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "⛔ این بخش فقط برای Owner است.", show_alert: true });
    return;
  }
  // Acknowledge before Core/Durable Object work so Telegram does not time out long monitoring callbacks.
  try { await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id }); } catch {}
  try { await registryRequest(env, '/activity/record', { telegramUserId: callback.from.id, action: callback.data || 'message', firstName: callback.from.first_name, username: callback.from.username }); } catch {}
  let result;
  const languageChoice = callback.data?.match(/^language:set:(fa|en)$/);
  if (languageChoice) {
    const saved = await registryRequest(env, "/language/set", { telegramUserId: callback.from.id, language: languageChoice[1] });
    locale = normalizeLanguage(saved.language);
    result = resolveCallback("language:selected:" + locale, callback.from.first_name, role, {}, locale);
  } else if (callback.data === "home:panel") {
    const memberMenu = buildRoleMenu("MEMBER");
    if (role === "OWNER") memberMenu.inline_keyboard.push([{ text: "⬅️ پنل Owner", callback_data: "home:admin" }]);
    result = { text: "🧩 پنل کاربری KageCatch\n\nیک بخش را انتخاب کن:", keyboard: memberMenu };
  } else if (callback.data === "home:admin" && role === "OWNER") {
    result = { text: "👑 پنل مدیریت KageCatch\n\nبخش مدیریتی موردنظرت را انتخاب کن:", keyboard: buildRoleMenu("OWNER") };
  } else if (callback.data === "home:status") {
    result = { text: "📊 وضعیت KageCatch\n\nControl Worker: فعال\nPython Core: متصل نیست\nاتصال حساب: هنوز فعال نشده\nاجرای Catch: غیرفعال", keyboard: { inline_keyboard: [[{ text: "⬅️ منوی شروع", callback_data: "menu:main" }]] } };
  } else if (callback.data === "home:help") {
    result = { text: "❓ راهنمای KageCatch\n\nبرای ورود به امکانات، پنل کاربری را انتخاب کن. دستورهای /panel و /status هم میانبر هستند.", keyboard: { inline_keyboard: [[{ text: "🧩 پنل کاربری", callback_data: "home:panel" }], [{ text: "⬅️ منوی شروع", callback_data: "menu:main" }]] } };
  } else if (callback.data === "owner:stats" || callback.data === "owner:stats:refresh") {
    result = buildOwnerDashboard(await loadOwnerStats(env));
  } else if (callback.data === "owner:monitor" || callback.data === "owner:monitor:refresh") {
    result = buildOwnerMonitor(await loadOwnerMonitoring(env));
  } else if (callback.data?.startsWith("owner:")) {
    result = await handleOwnerCallback(callback, env);
  } else if (callback.data === "catch:reviews") {
    if (chat.id !== callback.from.id) {
      result = { text: "این عملیات فقط در گفت‌وگوی خصوصی خودت مجاز است.", keyboard: backMenu(locale) };
    } else {
      result = await loadManualReviewPanel(env, callback.from.id, locale);
    }
  } else if ((callback.data || "").match(/^review:reject:([a-f0-9]{32})$/)) {
    const match = callback.data.match(/^review:reject:([a-f0-9]{32})$/);
    if (chat.id !== callback.from.id) {
      result = { text: "⛔ دسترسی نامعتبر است.", keyboard: backMenu(locale) };
    } else {
      const path = "/v1/reviews/" + callback.from.id + "/" + match[1] + "/reject";
      const rejected = await coreRequest(env, "POST", path);
      result = rejected.status >= 200 && rejected.status < 300
        ? await loadManualReviewPanel(env, callback.from.id, locale)
        : { text: locale === "fa" ? "این درخواست دیگر در وضعیت انتظار نیست یا قابل دسترسی نیست." : "This review is no longer pending or is unavailable.", keyboard: { inline_keyboard: [[{ text: translate("catcher.reviews", locale), callback_data: "catch:reviews" }], ...backMenu(locale).inline_keyboard] } };
    }
  } else if ((callback.data || "").match(/^review:approve:([a-f0-9]{32}):(0|[1-9][0-9]?)$/)) {
    const match = callback.data.match(/^review:approve:([a-f0-9]{32}):(0|[1-9][0-9]?)$/);
    if (chat.id !== callback.from.id) {
      result = { text: "⛔ دسترسی نامعتبر است.", keyboard: backMenu(locale) };
    } else {
      const path = "/v1/reviews/" + callback.from.id + "/" + match[1] + "/approve";
      const approval = await coreRequest(env, "POST", path, { candidate_index: Number(match[2]) });
      const disabled = approval.status === 503 && approval.data?.detail === "review_execution_not_configured";
      result = {
        text: disabled
          ? (locale === "fa"
            ? "🔒 <b>اجرای Catch هنوز به این کنترل متصل نیست.</b>\n\nانتخاب تو ثبت یا اجرا نشد؛ هیچ فرمانی به بات مقصد ارسال نشده است."
            : "🔒 <b>Catch execution is not connected yet.</b>\n\nYour selection was not committed or executed. No command was sent to a target bot.")
          : (locale === "fa" ? "تأیید انجام نشد؛ درخواست همچنان در صف بررسی است." : "Approval was not completed; the review remains pending."),
        parse_mode: "HTML",
        keyboard: { inline_keyboard: [
          [{ text: translate("catcher.reviews", locale), callback_data: "catch:reviews" }],
          ...backMenu(locale).inline_keyboard,
        ] },
      };
    }
  } else {
    const needsRuntimeStatus = ["overview:open", "catch:open", "account:list"].includes(callback.data) || callback.data === "menu:main";
    const runtimeStatus = needsRuntimeStatus
      ? await loadRuntimeStatus(env, callback.from.id, callback.data === "account:list")
      : {};
    const resolvedData = callback.data === "menu:main" ? "overview:open" : callback.data;
    result = resolveCallback(resolvedData, callback.from.first_name, role, runtimeStatus, locale);
  }
  if (callback.data === 'account:connect') {
    const link=await createConnectionLink(env,callback.from.id);
    result = {
      text: '🟢 بزن بریم حسابت رو وصل کنیم! لینک امن مخصوص خودت آماده شد؛ تا ۵ دقیقه اعتبار داره.',
      keyboard: { inline_keyboard: [[{ text: '🌸 اتصال امن حساب', url: link }], [{ text: 'منوی اصلی', callback_data: 'menu:main' }]] },
    };
  }
  if (result.alert) {
    // The callback was already acknowledged; the message itself carries the validation notice.
  }
  await telegramApi(env, "editMessageText", {
    chat_id: chat.id,
    message_id: callback.message.message_id,
    text: result.text,
    ...(result.parse_mode ? { parse_mode: result.parse_mode } : {}),
    reply_markup: result.keyboard,
  });
}

const CONNECTION_LOGIN_HTML = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>اتصال حساب | KageCatch</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#100d17;color:#f7edf7}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(ellipse at top,#382039 0,transparent 55%),#100d17}.card{width:min(100%,440px);padding:26px;border:1px solid #553c58;border-radius:24px;background:#1b1622;box-shadow:0 20px 70px #0008}h1{font-size:24px;margin:0 0 10px}p{color:#c5b5c9;line-height:1.9}.field{display:grid;gap:8px;margin:18px 0}label{font-weight:650}input{width:100%;padding:15px;border-radius:13px;border:1px solid #59455e;background:#120e19;color:white;font-size:17px}button{width:100%;padding:15px;border:0;border-radius:14px;background:#e98fc8;color:#271426;font-weight:750;font-size:16px;margin-top:12px}button:disabled{opacity:.55}.hint{font-size:13px;color:#a99bad}.status{min-height:52px;margin-top:16px;color:#f2b7df;line-height:1.8}.hidden{display:none}.brand{color:#eea0d1;font-size:12px;letter-spacing:3px;margin-bottom:18px}
</style></head><body><main class="card"><div class="brand">KAGECATCH · SECURE LOGIN</div><h1>اتصال حساب تلگرام 🌸</h1><p id="intro">شماره‌ات رو وارد کن تا کد ورود تلگرام برات ارسال بشه.</p>
<form id="login"><div class="field" id="phone-field"><label for="phone">شماره تلفن</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+989..." required></div>
<div class="field hidden" id="code-field"><label for="code">کد ورود تلگرام</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></div>
<div class="field hidden" id="password-field"><label for="password">رمز دومرحله‌ای</label><input id="password" name="password" type="password" autocomplete="off" maxlength="256"></div>
<button id="submit" type="submit">ارسال کد</button></form><div id="status" class="status" role="status" aria-live="polite"></div><p class="hint">این صفحه فقط برای اتصال حساب KageCatch است. کد و رمزت ذخیره یا در چت بات فرستاده نمی‌شوند.</p></main>
<script>
(()=>{const form=document.querySelector("#login"),status=document.querySelector("#status"),intro=document.querySelector("#intro"),submit=document.querySelector("#submit"),phoneField=document.querySelector("#phone-field"),codeField=document.querySelector("#code-field"),passwordField=document.querySelector("#password-field");let stage="phone",sessionToken="",busy=false;submit.disabled=true;
const show=(next,message)=>{stage=next;phoneField.classList.toggle("hidden",next!=="phone");codeField.classList.toggle("hidden",next!=="code");passwordField.classList.toggle("hidden",next!=="password");document.querySelector("#phone").required=next==="phone";document.querySelector("#code").required=next==="code";document.querySelector("#password").required=next==="password";submit.textContent=next==="phone"?"ارسال کد":next==="code"?"تأیید کد":"تأیید و اتصال";intro.textContent=next==="phone"?"شماره‌ات رو وارد کن تا کد ورود تلگرام برات ارسال بشه.":next==="code"?"کدی که تلگرام فرستاده رو همین‌جا وارد کن.": "رمز دومرحله‌ای تلگرامت رو وارد کن.";status.textContent=message||"";};
const api=async(action,data={})=>{const r=await fetch("/connect/api",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+sessionToken},body:JSON.stringify({action,...data}),cache:"no-store"});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error||"request_failed");return body;};
(async()=>{const linkToken=location.pathname.split("/").pop();if(!/^[A-Za-z0-9_-]{40,}$/.test(linkToken)){show("phone","لینک اتصال معتبر نیست.");submit.disabled=true;return;}try{const r=await fetch("/connect/exchange",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:linkToken}),cache:"no-store"});const body=await r.json();if(!r.ok)throw new Error(body.error||"link_expired");sessionToken=body.sessionToken;history.replaceState(null,"","/connect");submit.disabled=false;status.textContent="لینک امن تأیید شد؛ می‌تونیم شروع کنیم."; }catch{show("phone","این لینک منقضی شده یا قبلاً استفاده شده. از داخل بات یه لینک تازه بگیر.");submit.disabled=true;}})();
form.addEventListener("submit",async event=>{event.preventDefault();if(busy||!sessionToken)return;busy=true;submit.disabled=true;const submittedStage=stage;try{let result;if(stage==="phone"){const phone=document.querySelector("#phone").value.trim();if(!/^\\+[1-9]\\d{7,14}$/.test(phone))throw new Error("invalid_phone");result=await api("start",{phone});if(result.status==="already_authorized"){await api("reconnect");show("phone","حسابت از قبل مجاز بود؛ اتصال دوباره برقرار شد. 🎉");form.classList.add("hidden");return;}show("code","کد ورود ارسال شد. فقط همین‌جا واردش کن.");}else if(stage==="code"){result=await api("code",{code:document.querySelector("#code").value.trim()});if(result.status==="password_required"){show("password","حساب تلگرامت رمز دومرحله‌ای داره.");return;}show("phone",result.status==="connected"?"حساب تلگرامت با موفقیت وصل شد! 🎉":"ورود تأیید و نشست ذخیره شد؛ اتصال سرویس هنوز کامل نشده.");form.classList.add("hidden");}else{result=await api("password",{password:document.querySelector("#password").value});show("phone",result.status==="connected"?"حساب تلگرامت با موفقیت وصل شد! 🎉":"ورود تأیید و نشست ذخیره شد؛ اتصال سرویس هنوز کامل نشده.");form.classList.add("hidden");}}catch(error){const messages={invalid_phone:"شماره رو با کد کشور وارد کن.",telegram_code_request_failed:"تلگرام فعلاً نتونست کد بفرسته؛ کمی بعد دوباره امتحان کن.",invalid_telegram_code:"کد ورود درست نیست؛ دوباره بررسیش کن.",authorization_expired:"مهلت ورود تموم شد. از بات لینک تازه بگیر.",invalid_2fa_password:"رمز دومرحله‌ای درست نیست.",core_unavailable:"ارتباط با سرویس برقرار نشد؛ دوباره تلاش کن."};status.textContent=messages[error.message]||"اتصال انجام نشد. دوباره تلاش کن."; }finally{if(submittedStage==="code")document.querySelector("#code").value="";if(submittedStage==="password")document.querySelector("#password").value="";if(submittedStage==="phone"&&form.classList.contains("hidden"))document.querySelector("#phone").value="";busy=false;submit.disabled=!sessionToken||form.classList.contains("hidden");}});
})();
</script></body></html>`;
function securePageHeaders(extra={}){return { "content-type":"text/html; charset=utf-8","cache-control":"no-store, max-age=0","referrer-policy":"no-referrer","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'","permissions-policy":"camera=(), microphone=(), geolocation=()","x-robots-tag":"noindex, nofollow, noarchive",...extra};}
async function connectionLanding(request, env, token) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return new Response("Invalid link", { status: 404 });
  return new Response(CONNECTION_LOGIN_HTML, { headers: securePageHeaders() });
}
async function connectionExchange(request, env) {
  if(request.method!=="POST")return json({error:"method_not_allowed"},405);
  if(!(request.headers.get("content-type")||"").toLowerCase().startsWith("application/json"))return json({error:"unsupported_media_type"},415);
  let body;try{body=await request.json();}catch{return json({error:"invalid_request"},400);}
  if(typeof body?.token!=="string"||body.token.length>128||! /^[A-Za-z0-9_-]{40,}$/.test(body.token)||!env.CONNECT_LINKS)return json({error:"invalid_link"},400);
  const stub=env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const response=await stub.fetch("https://connect-links.internal/consume",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:body.token})});
  if(!response.ok)return json({error:"invalid_or_expired_link"},410);
  return json(await response.json());
}
async function standaloneConnectApi(request,env){
  if(request.method!=="POST")return json({error:"method_not_allowed"},405);
  if(!(request.headers.get("content-type")||"").toLowerCase().startsWith("application/json"))return json({error:"unsupported_media_type"},415);
  const bearer=(request.headers.get("authorization")||"").match(/^Bearer ([A-Za-z0-9_-]{40,})$/);
  if(!bearer||!env.CONNECT_LINKS)return json({error:"unauthorized"},401);
  let body;try{body=await request.json();}catch{return json({error:"invalid_request"},400);}
  const stub=env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const sessionResponse=await stub.fetch("https://connect-links.internal/browser-session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionToken:bearer[1]})});
  if(!sessionResponse.ok)return json({error:"session_expired"},401);
  const {telegramUserId}=await sessionResponse.json();
  const path="/v1/accounts/"+telegramUserId;
  const action=body?.action;
  const spec=action==="status"?{method:"GET",path}
    :action==="start"?{method:"POST",path:path+"/connect",payload:{phone:body.phone}}
    :action==="code"?{method:"POST",path:path+"/connect/code",payload:{code:body.code}}
    :action==="password"?{method:"POST",path:path+"/connect/password",payload:{password:body.password}}
    :action==="reconnect"?{method:"POST",path:path+"/reconnect"}
    :action==="cancel"?{method:"POST",path:path+"/connect/cancel"}:null;
  if(!spec)return json({error:"unknown_action"},400);
  const result=await coreRequest(env,spec.method,spec.path,spec.payload??null);
  if(result.status<200||result.status>=300)return json({error:result.data?.error||result.data?.detail||"core_request_failed"},result.status);
  if (["start", "code", "password", "reconnect"].includes(action)) {
    try { await registryRequest(env, "/activity/record", { telegramUserId, action: "account:connect" }); } catch {}
  }
  return json(result.data,result.status);
}

function logWebhookFailure(stage, updateId, error) {
  // Never log Telegram payloads, chat/user IDs, tokens, signatures, or raw error messages.
  console.error(JSON.stringify({
    event: "telegram_webhook_processing_failed",
    stage,
    update_id: Number.isSafeInteger(updateId) ? updateId : null,
    error_name: typeof error?.name === "string" ? error.name.slice(0, 64) : "Error",
    upstream_status: Number.isInteger(error?.status) ? error.status : null,
  }));
}

async function handleWebhook(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response("Webhook secret missing", { status: 503 });
  const valid = await verifySecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TELEGRAM_WEBHOOK_SECRET);
  if (!valid) return new Response("Unauthorized", { status: 401 });
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return new Response("Unsupported Media Type", { status: 415 });
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return new Response("Payload Too Large", { status: 413 });
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return new Response("Payload Too Large", { status: 413 });
  let update;
  try { update = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response("Bad Request", { status: 400 }); }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return new Response("Bad Request", { status: 400 });

  if (update.callback_query) {
    try {
      await handleCallback(update.callback_query, env);
    } catch (error) {
      logWebhookFailure("callback", update.update_id, error);
      return new Response("Telegram delivery failed", { status: 502 });
    }
    return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const message = update.message;
  if (message && message.chat?.type === "private" && Number.isSafeInteger(message.chat.id) && typeof message.text === "string" && Number.isSafeInteger(message.from?.id)) {
    const command = message.text.trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
    if (command === "/start" || command === "/panel") {
      try {
        let actor = await getTelegramUser(env, message.from.id);
        const startPayload = message.text.trim().split(/\s+/, 2)[1] || '';
        if (String(message.from.id) === String(env.OWNER_TELEGRAM_ID || '') && /^\\d+$/.test(String(env.OWNER_TELEGRAM_ID || ''))) {
          actor = await registryRequest(env, '/register', { telegramUserId: message.from.id, ownerTelegramId: env.OWNER_TELEGRAM_ID });
        } else if (!actor && command === '/start' && startPayload.startsWith('inv_')) {
          try {
            const redemption = await registryRequest(env, '/invite/consume', { telegramUserId: message.from.id, token: startPayload.slice(4) });
            actor = redemption.user;
          } catch (error) {
            if (error.status !== 410 && error.status !== 403) throw error;
          }
        }
        const role = resolveRole(message.from.id, env.OWNER_TELEGRAM_ID, actor?.role, actor?.status);
        if (actor && role !== 'DENIED' && role !== 'BLOCKED') { try { await registryRequest(env, '/activity/record', { telegramUserId: message.from.id, action: command === '/panel' ? 'panel' : 'start', firstName: message.from.first_name, username: message.from.username }); } catch {} }
        const locale = normalizeLanguage(actor?.language);
        const reply = role === 'BLOCKED' || role === 'DENIED'
          ? { text: actor ? "⛔ دسترسی شما به KageCatch فعال نیست. با Owner تماس بگیر." : "🔐 برای ورود به KageCatch به لینک دعوت نیاز داری. از Owner درخواست دعوت کن." }
          : {
              text: buildDashboardText(message.from.first_name, await loadRuntimeStatus(env, message.from.id), locale),
              parse_mode: "HTML",
              reply_markup: command === "/start" ? buildStartMenu(role, locale) : buildRoleMenu(role, locale),
            };
        await telegramApi(env, "sendMessage", { chat_id: message.chat.id, ...reply });
      } catch (error) {
        logWebhookFailure("start", update.update_id, error);
        return new Response("User registry unavailable", { status: 503 });
      }
      return new Response("OK", { status: 200 });
    }
    const actor = await getTelegramUser(env, message.from.id);
    const role = resolveRole(message.from.id, env.OWNER_TELEGRAM_ID, actor?.role, actor?.status);
    if (role === 'BLOCKED' || role === 'DENIED') {
      await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⛔ ابتدا باید دسترسی شما توسط Owner فعال شود." });
      return new Response("OK", { status: 200 });
    }
    try { await registryRequest(env, '/activity/record', { telegramUserId: message.from.id, action: command.startsWith('/') ? 'command' : 'message', firstName: message.from.first_name, username: message.from.username }); } catch {}
    if (role === 'OWNER') {
      const broadcastState = await registryRequest(env, '/broadcast', { ownerTelegramId: message.from.id, action: 'get' });
      if (broadcastState.draft?.status === 'awaiting_text') {
        if (command === '/cancel') {
          await registryRequest(env, '/broadcast', { ownerTelegramId: message.from.id, action: 'clear' });
          await telegramApi(env, 'sendMessage', { chat_id: message.chat.id, text: 'ارسال همگانی لغو شد.', reply_markup: BACK_MENU });
          return new Response("OK", { status: 200 });
        }
        try {
          const draft = await registryRequest(env, '/broadcast', { ownerTelegramId: message.from.id, action: 'save', text: message.text });
          const preview = draft.text.length > 3500 ? draft.text.slice(0, 3500) + '\n… (پیش‌نمایش کوتاه‌شده)' : draft.text;
          await telegramApi(env, 'sendMessage', {
            chat_id: message.chat.id,
            text: '👀 پیش‌نمایش پیام همگانی:\n\n' + preview + '\n\nاین پیام برای اعضای فعال ارسال شود؟',
            reply_markup: { inline_keyboard: [[
              { text: '✅ تأیید و ارسال', callback_data: 'owner:broadcast:confirm' },
              { text: '❌ لغو', callback_data: 'owner:broadcast:cancel' },
            ]] },
          });
        } catch {
          await telegramApi(env, 'sendMessage', { chat_id: message.chat.id, text: 'متن خالی یا بیش از ۴۰۹۶ کاراکتر است. یک متن معتبر بفرست یا /cancel را بزن.' });
        }
        return new Response("OK", { status: 200 });
      }
    }
    if (command === "/admin" && role !== 'OWNER') {
      await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⛔ این بخش فقط برای Owner است." });
      return new Response("OK", { status: 200 });
    }
    if (command === "/admin") {
      await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "👑 پنل مدیریت KageCatch", reply_markup: buildRoleMenu("OWNER") });
      return new Response("OK", { status: 200 });
    }
    if (command === "/status" && role === "MEMBER") {
      await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "📊 وضعیت حساب شما در KageCatch\n\nنقش: MEMBER\nدسترسی: فعال\nمدیریت حساب‌ها و آمار شخصی از پنل در دسترس است.", reply_markup: buildRoleMenu("MEMBER") });
      return new Response("OK", { status: 200 });
    }
    const reply = commandReply(message.text);
    if (reply) {
      try { await telegramApi(env, "sendMessage", { chat_id: message.chat.id, ...reply, ...(command === "/status" || command === "/help" ? { reply_markup: buildRoleMenu(role) } : {}) }); }
      catch { return new Response("Telegram delivery failed", { status: 502 }); }
    }
  }
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}


function reviewRowToItem(row) {
  let candidates;
  let spawnContext = null;
  try { candidates = JSON.parse(row.candidates_json); } catch { throw new Error("invalid stored candidates"); }
  if (!Array.isArray(candidates)) throw new Error("invalid stored candidates");
  if (row.spawn_context_json) {
    try { spawnContext = JSON.parse(row.spawn_context_json); }
    catch { throw new Error("invalid stored spawn context"); }
    if (!spawnContext || typeof spawnContext !== "object" || Array.isArray(spawnContext)
      || typeof spawnContext.source !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(spawnContext.source)
      || !Number.isSafeInteger(spawnContext.chat_id)
      || !Number.isSafeInteger(spawnContext.message_id) || spawnContext.message_id !== row.spawn_id
      || !["photo", "video", "document", "animation", "audio"].includes(spawnContext.media_kind)) {
      throw new Error("invalid stored spawn context");
    }
  }
  return {
    review_id: row.review_id,
    user_id: row.user_id,
    spawn_id: row.spawn_id,
    anime_name: row.anime_name,
    candidates,
    spawn_context: spawnContext,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status: row.status,
    selected_character: row.selected_character ?? null,
  };
}

async function internalManualReviewStore(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  if (!env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32) return json({ error: "storage_auth_not_configured" }, 503);
  if (!env.KAGECATCH_DB || !env.CONNECT_LINKS) return json({ error: "storage_not_configured" }, 503);

  let rawBody;
  try { rawBody = new Uint8Array(await request.arrayBuffer()); } catch { return json({ error: "invalid_request" }, 400); }
  if (rawBody.byteLength > 64 * 1024) return json({ error: "request_too_large" }, 413);
  const timestampRaw = request.headers.get("X-KageCatch-Timestamp") || "";
  const nonce = request.headers.get("X-KageCatch-Nonce") || "";
  const supplied = request.headers.get("X-KageCatch-Signature") || "";
  if (!/^\d{10,12}$/.test(timestampRaw) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) return json({ error: "invalid_auth_headers" }, 401);
  const timestamp = Number(timestampRaw);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > 60) return json({ error: "request_expired" }, 401);
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signingText = [timestampRaw, nonce, request.method, new URL(request.url).pathname, bodyHash].join("\n");
  const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CORE_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(signingText)));
  const expected = Array.from(expectedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  if (difference !== 0) return json({ error: "invalid_signature" }, 401);

  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const claim = await stub.fetch("https://connect-links.internal/claim-nonce", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, expiresAt: Date.now() + 120000 }),
  });
  if (claim.status === 409) return json({ error: "request_replayed" }, 409);
  if (!claim.ok) return json({ error: "replay_guard_unavailable" }, 503);

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(rawBody)); }
  catch { return json({ error: "invalid_request" }, 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ error: "invalid_request" }, 400);
  const now = new Date().toISOString();

  try {
    if (payload.action === "create") {
      const { review_id, user_id, spawn_id, anime_name, candidates, created_at, expires_at, spawn_context } = payload;
      if (typeof review_id !== "string" || !/^[a-f0-9]{32}$/.test(review_id)
        || typeof user_id !== "string" || !user_id || user_id.length > 128
        || !Number.isSafeInteger(spawn_id) || spawn_id < 0
        || typeof anime_name !== "string" || !anime_name.trim() || anime_name.length > 300
        || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 30
        || candidates.some((name) => typeof name !== "string" || !name.trim() || name.length > 100)
        || typeof created_at !== "string" || typeof expires_at !== "string"
        || !Number.isFinite(Date.parse(created_at)) || !Number.isFinite(Date.parse(expires_at))
        || Date.parse(expires_at) <= Date.parse(created_at)
        || (spawn_context !== undefined && spawn_context !== null && (
          typeof spawn_context !== "object" || Array.isArray(spawn_context)
          || typeof spawn_context.source !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(spawn_context.source)
          || !Number.isSafeInteger(spawn_context.chat_id)
          || !Number.isSafeInteger(spawn_context.message_id) || spawn_context.message_id !== spawn_id
          || !["photo", "video", "document", "animation", "audio"].includes(spawn_context.media_kind)
        ))) return json({ error: "invalid_review_item" }, 400);
      const inserted = await env.KAGECATCH_DB.prepare(
        "INSERT INTO manual_review_items (review_id, user_id, spawn_id, anime_name, candidates_json, spawn_context_json, created_at, expires_at, status, selected_character) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL WHERE (SELECT COUNT(*) FROM manual_review_items WHERE user_id = ? AND status = 'pending' AND expires_at > ?) < 100"
      ).bind(review_id, user_id, spawn_id, anime_name.trim(), JSON.stringify(candidates), spawn_context ? JSON.stringify(spawn_context) : null, new Date(created_at).toISOString(), new Date(expires_at).toISOString(), user_id, now).run();
      if (Number(inserted?.meta?.changes || 0) !== 1) return json({ error: "pending_queue_limit_reached" }, 429);
      return json({ status: "created" }, 201);
    }

    if (payload.action === "expire") {
      const result = await env.KAGECATCH_DB.prepare(
        "UPDATE manual_review_items SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?"
      ).bind(now).run();
      return json({ expired: Number(result?.meta?.changes || 0) });
    }

    if (payload.action === "list") {
      if (typeof payload.user_id !== "string" || !payload.user_id || payload.user_id.length > 128) return json({ error: "invalid_user_id" }, 400);
      await env.KAGECATCH_DB.prepare(
        "UPDATE manual_review_items SET status = 'expired' WHERE user_id = ? AND status = 'pending' AND expires_at <= ?"
      ).bind(payload.user_id, now).run();
      const result = await env.KAGECATCH_DB.prepare(
        "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, spawn_context_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE user_id = ? AND status = 'pending' ORDER BY created_at, review_id LIMIT 100"
      ).bind(payload.user_id).all();
      return json({ items: (result?.results || []).map(reviewRowToItem) });
    }

    if (payload.action === "approve" || payload.action === "reject") {
      const { user_id, review_id } = payload;
      if (typeof user_id !== "string" || !user_id || user_id.length > 128
        || typeof review_id !== "string" || !/^[a-f0-9]{32}$/.test(review_id)) return json({ error: "invalid_review_id" }, 400);
      const row = await env.KAGECATCH_DB.prepare(
        "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, spawn_context_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE review_id = ? AND user_id = ?"
      ).bind(review_id, user_id).first();
      if (!row) return json({ error: "review_item_not_found" }, 404);
      if (row.status !== "pending") return json({ error: "review_item_already_resolved" }, 409);
      if (Date.parse(row.expires_at) <= Date.parse(now)) {
        await env.KAGECATCH_DB.prepare(
          "UPDATE manual_review_items SET status = 'expired' WHERE review_id = ? AND user_id = ? AND status = 'pending'"
        ).bind(review_id, user_id).run();
        const expiredRow = await env.KAGECATCH_DB.prepare(
          "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, spawn_context_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE review_id = ? AND user_id = ?"
        ).bind(review_id, user_id).first();
        return json({ item: reviewRowToItem(expiredRow) });
      }
      const candidates = JSON.parse(row.candidates_json);
      let selected = null;
      if (payload.action === "approve") {
        if (!Number.isSafeInteger(payload.candidate_index) || payload.candidate_index < 0 || payload.candidate_index >= candidates.length) return json({ error: "candidate_index_out_of_range" }, 400);
        selected = candidates[payload.candidate_index];
      }
      const nextStatus = payload.action === "approve" ? "approved" : "rejected";
      const update = await env.KAGECATCH_DB.prepare(
        "UPDATE manual_review_items SET status = ?, selected_character = ? WHERE review_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?"
      ).bind(nextStatus, selected, review_id, user_id, now).run();
      if (Number(update?.meta?.changes || 0) !== 1) return json({ error: "review_item_already_resolved" }, 409);
      const updatedRow = await env.KAGECATCH_DB.prepare(
        "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, spawn_context_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE review_id = ? AND user_id = ?"
      ).bind(review_id, user_id).first();
      return json({ item: reviewRowToItem(updatedRow) });
    }
    return json({ error: "invalid_action" }, 400);
  } catch {
    return json({ error: "manual_review_store_unavailable" }, 503);
  }
}


async function internalSessionStore(request, env) {
  const pathname = new URL(request.url).pathname;
  const listUsers = pathname === "/internal/session-store/users";
  const match = pathname.match(/^\/internal\/session-store\/([1-9][0-9]{0,15})$/);
  if (!match && !listUsers) return json({ error: "not_found" }, 404);
  if (listUsers ? request.method !== "GET" : !["GET", "PUT", "DELETE"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
  if (!env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32) return json({ error: "storage_auth_not_configured" }, 503);
  if (!env.KAGECATCH_DB || !env.CONNECT_LINKS) return json({ error: "storage_not_configured" }, 503);
  const userId = match?.[1];
  if (!listUsers && Number(userId) > (2 ** 52 - 1)) return json({ error: "invalid_user_id" }, 400);
  let rawBody;
  try { rawBody = new Uint8Array(await request.arrayBuffer()); } catch { return json({ error: "invalid_request" }, 400); }
  if (rawBody.byteLength > 8192) return json({ error: "request_too_large" }, 413);
  if (request.method === "PUT" && !(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  if (request.method !== "PUT" && rawBody.byteLength !== 0) return json({ error: "unexpected_request_body" }, 400);
  const timestampRaw = request.headers.get("X-KageCatch-Timestamp") || "";
  const nonce = request.headers.get("X-KageCatch-Nonce") || "";
  const supplied = request.headers.get("X-KageCatch-Signature") || "";
  if (!/^\d{10,12}$/.test(timestampRaw) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) return json({ error: "invalid_auth_headers" }, 401);
  const timestamp = Number(timestampRaw);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 60) return json({ error: "request_expired" }, 401);
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signingText = [timestampRaw, nonce, request.method, new URL(request.url).pathname, bodyHash].join("\n");
  const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CORE_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(signingText)));
  const expected = Array.from(expectedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  if (difference !== 0) return json({ error: "invalid_signature" }, 401);
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const claim = await stub.fetch("https://connect-links.internal/claim-nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, expiresAt: Date.now() + 120000 }),
  });
  if (claim.status === 409) return json({ error: "request_replayed" }, 409);
  if (!claim.ok) return json({ error: "replay_guard_unavailable" }, 503);
  if (listUsers) {
    if (rawBody.byteLength !== 0) return json({ error: "unexpected_request_body" }, 400);
    try {
      const result = await env.KAGECATCH_DB.prepare(
        "SELECT user_id FROM telegram_sessions ORDER BY user_id"
      ).all();
      const users = (result?.results || []).map((row) => String(row.user_id));
      return json({ users });
    } catch {
      return json({ error: "session_store_unavailable" }, 503);
    }
  }
  let payload = null;
  if (rawBody.byteLength) {
    try { payload = JSON.parse(new TextDecoder().decode(rawBody)); }
    catch { return json({ error: "invalid_request" }, 400); }
  }
  try {
    if (request.method === "PUT") {
      const ciphertext = payload?.ciphertext;
      if (typeof ciphertext !== "string" || ciphertext.length < 16 || ciphertext.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) return json({ error: "invalid_ciphertext" }, 400);
      await env.KAGECATCH_DB.prepare(
        "INSERT INTO telegram_sessions (user_id, encrypted_session, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET encrypted_session=excluded.encrypted_session, updated_at=CURRENT_TIMESTAMP"
      ).bind(userId, ciphertext).run();
      return json({ status: "stored" });
    }
    if (request.method === "GET") {
      const row = await env.KAGECATCH_DB.prepare("SELECT encrypted_session FROM telegram_sessions WHERE user_id = ?").bind(userId).first();
      if (!row) return json({ error: "session_not_found" }, 404);
      return json({ ciphertext: row.encrypted_session });
    }
    await env.KAGECATCH_DB.prepare("DELETE FROM telegram_sessions WHERE user_id = ?").bind(userId).run();
    return json({ status: "deleted" });
  } catch {
    return json({ error: "session_store_unavailable" }, 503);
  }
}

async function internalAuthChallengeStore(request, env) {
  const match = new URL(request.url).pathname.match(/^\/internal\/auth-challenge\/([1-9][0-9]{0,15})$/);
  if (!match) return json({ error: "not_found" }, 404);
  if (!["GET", "PUT", "DELETE"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
  if (!env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32) return json({ error: "storage_auth_not_configured" }, 503);
  if (!env.KAGECATCH_DB || !env.CONNECT_LINKS) return json({ error: "storage_not_configured" }, 503);
  const userId = match[1];
  if (Number(userId) > (2 ** 52 - 1)) return json({ error: "invalid_user_id" }, 400);
  let rawBody;
  try { rawBody = new Uint8Array(await request.arrayBuffer()); } catch { return json({ error: "invalid_request" }, 400); }
  if (rawBody.byteLength > 8192) return json({ error: "request_too_large" }, 413);
  if (request.method === "PUT" && !(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  if (request.method !== "PUT" && rawBody.byteLength !== 0) return json({ error: "unexpected_request_body" }, 400);
  const timestampRaw = request.headers.get("X-KageCatch-Timestamp") || "";
  const nonce = request.headers.get("X-KageCatch-Nonce") || "";
  const supplied = request.headers.get("X-KageCatch-Signature") || "";
  if (!/^\d{10,12}$/.test(timestampRaw) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) return json({ error: "invalid_auth_headers" }, 401);
  const timestamp = Number(timestampRaw);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 60) return json({ error: "request_expired" }, 401);
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signingText = [timestampRaw, nonce, request.method, new URL(request.url).pathname, bodyHash].join("\n");
  const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CORE_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(signingText)));
  const expected = Array.from(expectedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  if (difference !== 0) return json({ error: "invalid_signature" }, 401);
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const claim = await stub.fetch("https://connect-links.internal/claim-nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, expiresAt: Date.now() + 120000 }),
  });
  if (claim.status === 409) return json({ error: "request_replayed" }, 409);
  if (!claim.ok) return json({ error: "replay_guard_unavailable" }, 503);
  let payload = null;
  if (rawBody.byteLength) {
    try { payload = JSON.parse(new TextDecoder().decode(rawBody)); }
    catch { return json({ error: "invalid_request" }, 400); }
  }
  try {
    if (request.method === "PUT") {
      const ciphertext = payload?.ciphertext;
      if (typeof ciphertext !== "string" || ciphertext.length < 16 || ciphertext.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) return json({ error: "invalid_ciphertext" }, 400);
      await env.KAGECATCH_DB.prepare(
        "INSERT INTO telegram_auth_challenges (user_id, encrypted_payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload, updated_at=CURRENT_TIMESTAMP"
      ).bind(userId, ciphertext).run();
      return json({ status: "stored" });
    }
    if (request.method === "GET") {
      const row = await env.KAGECATCH_DB.prepare("SELECT encrypted_payload FROM telegram_auth_challenges WHERE user_id = ?").bind(userId).first();
      if (!row) return json({ error: "challenge_not_found" }, 404);
      return json({ ciphertext: row.encrypted_payload });
    }
    await env.KAGECATCH_DB.prepare("DELETE FROM telegram_auth_challenges WHERE user_id = ?").bind(userId).run();
    return json({ status: "deleted" });
  } catch {
    return json({ error: "auth_challenge_store_unavailable" }, 503);
  }
}


export default {
  async scheduled(controller, env) {
    if (controller?.cron !== "*/10 * * * *") {
      return { skipped: true, reason: "not_render_keepalive_schedule" };
    }
    return keepRenderCoreWarm(env, controller);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/admin/setup-webhook") return manualWebhookSetup(request, env);
    if (url.pathname === "/health" && request.method === "GET") return health(env);
    if (url.pathname === "/internal/panel-requests") {
      return enqueuePanelRequestAndDispatch(
        request,
        env,
        ctx,
        (method, payload) => telegramApi(env, method, payload),
      );
    }
    if (url.pathname === "/internal/manual-review") return internalManualReviewStore(request, env);
    if (url.pathname.startsWith("/internal/session-store/")) return internalSessionStore(request, env);
    if (url.pathname.startsWith("/internal/auth-challenge/")) return internalAuthChallengeStore(request, env);
    if (url.pathname === "/connect/exchange") return connectionExchange(request, env);
    if (url.pathname === "/connect/api") return standaloneConnectApi(request, env);
    if (url.pathname === "/api/session") return miniAppSession(request, env);
    if (url.pathname === "/api/account/status") return miniAppCoreProxy(request, env, "status");
    if (url.pathname === "/api/account/connect") return miniAppCoreProxy(request, env, "connect");
    if (url.pathname === "/api/account/connect/code") return miniAppCoreProxy(request, env, "connect-code");
    if (url.pathname === "/api/account/connect/password") return miniAppCoreProxy(request, env, "connect-password");
    if (url.pathname === "/api/account/connect/status") return miniAppCoreProxy(request, env, "connect-status");
    if (url.pathname === "/api/account/connect/cancel") return miniAppCoreProxy(request, env, "connect-cancel");
    if (url.pathname === "/api/account/reconnect") return miniAppCoreProxy(request, env, "reconnect");
    if (url.pathname === "/api/account/disconnect") return miniAppCoreProxy(request, env, "disconnect");
    if (url.pathname === "/api/account/revoke") return miniAppCoreProxy(request, env, "revoke");
    if (url.pathname === "/panel" && request.method === "GET") return panelPage();
    if (url.pathname.startsWith("/connect/")) return connectionLanding(request, env, decodeURIComponent(url.pathname.slice("/connect/".length)));
    if (url.pathname === WEBHOOK_PATH) return handleWebhook(request, env);
    return json({ error: "not_found" }, 404);
  },
};