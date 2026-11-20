import { enqueuePanelRequestAndDispatch, processPanelQueue, handlePanelCallback } from "./panel_queue.mjs";
import { buildLoginCodeKeyboard, maskLoginCode, parseLoginCodeCallback, validatePhoneNumber } from "./telegram_login_ui.mjs";
const WEBHOOK_PATH = "/webhook";
const MAX_BODY_BYTES = 256 * 1024;
const VERSION = "0.9.0";

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

export function buildRoleMenu(role = "MEMBER") {
  const memberRows = [
    [{ text: "🎯 کنترل Catch", callback_data: "catch:open" }, { text: "🤖 بات‌های مقصد", callback_data: "bots:open" }],
    [{ text: "🟢 اتصال حساب", callback_data: "account:connect" }, { text: "👤 حساب متصل من", callback_data: "account:list" }],
    [{ text: "📊 آمار من", callback_data: "stats:open" }, { text: "⚙️ تنظیمات", callback_data: "settings:open" }],
    [{ text: "🔒 امنیت حساب", callback_data: "security:open" }, { text: "❌ قطع اتصال", callback_data: "account:disconnect" }],
    [{ text: "❓ راهنما", callback_data: "help:open" }],
  ];
  if (role === "OWNER") return { inline_keyboard: [
    [{ text: "📊 نمای کلی", callback_data: "owner:stats" }, { text: "👁️ نظارت کاربران", callback_data: "owner:monitor" }],
    [{ text: "👥 مدیریت اعضا", callback_data: "owner:members" }],
    [{ text: "🎟️ مدیریت دعوت‌ها", callback_data: "owner:invites" }, { text: "⚙️ تنظیمات", callback_data: "owner:settings" }],
    [{ text: "📣 پیام همگانی", callback_data: "owner:broadcast" }, { text: "🛑 توقف اضطراری", callback_data: "owner:emergency" }],
    [{ text: "🧩 پنل کاربری", callback_data: "home:panel" }],
    ...memberRows,
  ] };
  return { inline_keyboard: memberRows };
}

export function buildMainMenu() { return buildRoleMenu("MEMBER"); }

export function buildStartMenu(role = "MEMBER") {
  return buildRoleMenu(role);
}

export function resolveRole(userId, ownerTelegramId, storedRole = "DENIED", status = "active") {
  if (status === "blocked") return "BLOCKED";
  if (!Number.isSafeInteger(userId)) return "DENIED";
  if (/^\d+$/.test(String(ownerTelegramId || "")) && String(userId) === String(ownerTelegramId)) return "OWNER";
  return storedRole === "MEMBER" ? "MEMBER" : "DENIED";
}
const BACK_MENU = { inline_keyboard: [[{ text: "⬅️ منوی اصلی", callback_data: "menu:main" }]] };

export function resolveCallback(data) {
  switch (data) {
    case "account:connect":
      return {
        text: "🟢 اتصال حساب تلگرام\n\nشماره تلفنت رو با پیش‌شماره کشور بفرست؛ مثل +98912…\nکد ورود را با کیبورد داخل بات وارد می‌کنی.",
        keyboard: BACK_MENU,
      };
    case "account:list":
      return { text: "👤 حساب‌های متصل\n\nبرای اضافه کردن حساب، از گزینهٔ «اتصال حساب» استفاده کن.", keyboard: BACK_MENU };
    case "catch:open":
      return {
        text: "🎯 بخش Catch\n\nهنوز آمادهٔ شکار واقعی نیستیم 😅\nداریم بخش تشخیص و گرفتن کاراکترها رو تکمیل می‌کنیم. تا وقتی همه‌چیز تست نشه، چیزی به‌صورت خودکار اجرا نمی‌شه.",
        keyboard: { inline_keyboard: [[{ text: "🤖 مشاهده بات‌های مقصد", callback_data: "bots:open" }], [{ text: "⚙️ تنظیمات Catch", callback_data: "settings:open" }], ...BACK_MENU.inline_keyboard] },
      };
    case "bots:open":
      return {
        text: "🤖 بات‌های مقصد\n\n• HentaCatcherBot — عکس · /catch\n• Character_Catcher_Bot — عکس · /catch\n• SenpaiCatcherBot — ویدیو · /pick (فعلاً غیرفعاله)\n\nهنوز تست واقعی نگرفتیم؛ پس فعلاً قول Catch موفق نمی‌دیم.",
        keyboard: { inline_keyboard: [[{ text: "🎯 کنترل Catch", callback_data: "catch:open" }], ...BACK_MENU.inline_keyboard] },
      };
    case "settings:open":
      return {
        text: "⚙️ تنظیمات\n\nبعضی تنظیمات هنوز آماده نیستن. به‌محض اینکه بخش مربوطه کامل بشه، از همین‌جا می‌تونی تغییرشون بدی.",
        keyboard: BACK_MENU,
      };
    case "stats:open":
      return { text: "📊 آمار تو\n\nهنوز آماری نداریم؛ وقتی Catch راه بیفته، نتیجه‌ها همین‌جا نمایش داده می‌شن.", keyboard: BACK_MENU };
    case "security:open":
      return {
        text: "🔒 امنیت و نشست‌ها\n\nکد ورود در کیبورد بات وارد می‌شود و در callback ذخیره نمی‌شود؛ فقط وضعیت موقت رمزنگاری‌شده نگهداری می‌شود. رمز دومرحله‌ای در پیام خصوصی دریافت و بلافاصله برای حذف آن اقدام می‌کنیم. نشست نهایی در Core رمزنگاری می‌شود. حذف پیام تضمین حذف از زیرساخت تلگرام نیست.",
        keyboard: BACK_MENU,
      };
    case "account:disconnect":
      return { text: "❌ حساب متصلی ثبت نشده است.", keyboard: BACK_MENU };
    case "help:open":
      return {
        text: "❓ راهنمای کوچیک KageCatch\n\n🎯 Catch — وضعیت شکار\n🤖 بات‌های مقصد — بات‌هایی که پشتیبانی می‌شن\n👤 حساب من — اتصال و مدیریت حسابت\n📊 آمار من — نتیجهٔ Catchها\n⚙️ تنظیمات — تنظیمات برنامه\n\nدستورها: /start منو · /status وضعیت · /help راهنما",
        keyboard: BACK_MENU,
      };
    case "menu:main":
      return { text: "🌸 سلام! خوش اومدی به KageCatch 😎\n\nاز منو هرچی لازم داری انتخاب کن:", keyboard: buildStartMenu() };
    default:
      return { text: "این گزینه معتبر نیست. منوی اصلی را دوباره باز کن.", keyboard: BACK_MENU, alert: true };
  }
}

export function commandReply(text) {
  const command = (text || "").trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start") {
    return {
      text: "🌸 سلام! خوش اومدی به KageCatch 😎\n\nاز این منو می‌تونی Catch، بات‌ها و حسابت رو مدیریت کنی:",
      reply_markup: buildStartMenu(),
    };
  }
  if (command === "/panel") {
    return {
      text: "🧩 اینم منوی KageCatch!\n\nبگو کدوم بخش رو می‌خوای:",
      reply_markup: buildMainMenu(),
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

export class ConnectionLinkStore {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    const url = new URL(request.url);
    let body;
    try { if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new Error('content type'); body = await request.json(); }
    catch { return json({ error: 'invalid_request' }, 400); }
    if (url.pathname === '/auth-state') {
      const { telegramUserId, action, state: authState } = body || {};
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || !['get', 'set', 'delete'].includes(action)) return json({ error: 'invalid_request' }, 400);
      const key = 'telegram-auth-state:' + telegramUserId;
      if (action === 'delete') { await this.state.storage.delete(key); return json({ status: 'deleted' }); }
      if (action === 'set') {
        if (!authState || !Array.isArray(authState.iv) || authState.iv.length !== 12 || !Array.isArray(authState.ciphertext) || authState.ciphertext.length < 16 || authState.ciphertext.length > 2048 || !Number.isSafeInteger(authState.expiresAt) || authState.expiresAt <= Date.now() || authState.expiresAt > Date.now() + 300000) return json({ error: 'invalid_auth_state' }, 400);
        await this.state.storage.put(key, authState);
        return json({ status: 'saved' });
      }
      const current = await this.state.storage.get(key);
      if (!current || current.expiresAt <= Date.now()) { if (current) await this.state.storage.delete(key); return json({ state: null }); }
      return json({ state: current });
    }
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
        : { telegramUserId, role: isOwner ? 'OWNER' : 'MEMBER', status: 'active', createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
      await this.state.storage.put(key, record);
      return json(record);
    }
    if (url.pathname === '/user') {
      const id = body?.telegramUserId;
      if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'invalid_request' }, 400);
      return json({ user: await this.state.storage.get('user:' + id) || null });
    }
    if (url.pathname === '/activity/record') {
      const { telegramUserId, action, firstName, username } = body || {};
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || typeof action !== 'string' || !/^(start|panel|message|command|catch:open|bots:open|account:connect|account:list|stats:open|settings:open|security:open|account:disconnect|help:open|owner:[a-z0-9:_-]+|home:[a-z]+)$/.test(action)) return json({ error: 'invalid_activity' }, 400);
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
    return json({ error: 'not_found' }, 404);
  }
}

async function registryRequest(env, path, payload) {
  if (!env.CONNECT_LINKS) throw new Error('User registry unavailable');
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName('connection-links-v1'));
  const response = await stub.fetch('https://connect-links.internal' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) { const error = new Error('User registry unavailable'); error.status = response.status; throw error; }
  return response.json();
}

// OTP state is encrypted at rest with AES-GCM and authenticated to its Telegram user ID.\nasync function authStateRequest(env, telegramUserId, action, state = null) {
  if (!env.CONNECT_LINKS) throw new Error("Temporary auth state store unavailable");
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  let encrypted = null;
  if (action === "set") {
    if (!env.CORE_API_SECRET || !state || !Number.isSafeInteger(state.expiresAt)) throw new Error("Auth state encryption is not configured");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CORE_API_SECRET));
    const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(String(telegramUserId)) }, key, new TextEncoder().encode(JSON.stringify(state)));
    encrypted = { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)), expiresAt: state.expiresAt };
  }
  const response = await stub.fetch("https://connect-links.internal/auth-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId, action, state: encrypted }),
  });
  if (!response.ok) throw new Error("Temporary auth state operation failed");
  const result = await response.json();
  if (action !== "get" || !result.state) return result;
  if (!env.CORE_API_SECRET) throw new Error("Auth state encryption is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CORE_API_SECRET));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(result.state.iv), additionalData: new TextEncoder().encode(String(telegramUserId)) }, key, new Uint8Array(result.state.ciphertext));
  return { state: JSON.parse(new TextDecoder().decode(plaintext)) };
}

async function beginTelegramLogin(env, telegramUserId, phone) {
  if (!validatePhoneNumber(phone)) throw new Error("invalid_phone");
  const path = "/v1/accounts/" + telegramUserId;
  const result = await coreRequest(env, "POST", path + "/connect", { phone: phone.trim() });
  if (result.status === 409 && result.data?.error === "authorization_already_pending") {
    const pending = await coreRequest(env, "GET", path + "/connect/status");
    if (pending.status === 200 && pending.data?.status === "pending") return "code_sent";
  }
  if (result.status < 200 || result.status >= 300) throw new Error(result.data?.error || "telegram_code_request_failed");
  if (result.data?.status === "already_authorized") {
    const reconnect = await coreRequest(env, "POST", path + "/reconnect");
    if (reconnect.status >= 200 && reconnect.status < 300) return "connected";
    return "reauthorization_required";
  }
  return result.data?.status || "code_sent";
}

async function getTelegramUser(env, userId) {
  const result = await registryRequest(env, '/user', { telegramUserId: userId });
  return result.user;
}


function activityLabel(action) {
  const labels = {
    start: "شروع بات", panel: "باز کردن پنل", message: "ارسال پیام (بدون ذخیره متن)", command: "اجرای دستور",
    "catch:open": "ورود به کنترل Catch", "bots:open": "مشاهده بات‌های مقصد", "account:connect": "اتصال حساب تلگرام",
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
  if (data === 'owner:stats') {
    const { users = [] } = await registryRequest(env, '/users', {});
    const active = users.filter((user) => user.status === 'active' && user.role === 'MEMBER').length;
    const blocked = users.filter((user) => user.status === 'blocked').length;
    const { invites = [] } = await registryRequest(env, '/invite/list', {});
    const usable = invites.filter((invite) => !invite.revokedAt && invite.expiresAt > Date.now() && invite.uses < invite.maxUses).length;
    return { text: '👑 نمای کلی KageCatch\n\n👥 اعضای فعال: ' + active + '\n🚫 مسدود: ' + blocked + '\n🎟️ دعوت‌های معتبر: ' + usable + '\n\nوضعیت Catch: خاموش · بدون اجرای زنده', keyboard: { inline_keyboard: [[{ text: '👥 اعضا', callback_data: 'owner:members' }, { text: '🎟️ دعوت‌ها', callback_data: 'owner:invites' }], ...BACK_MENU.inline_keyboard] } };
  }
  if (data === 'owner:monitor') {
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
    const rows = members.map((user) => [{ text: 'جزئیات ' + (user.firstName || user.telegramUserId), callback_data: 'owner:monitor:user:' + user.telegramUserId }]);
    rows.push([{ text: '🔄 بروزرسانی', callback_data: 'owner:monitor' }, { text: '⬅️ پنل Owner', callback_data: 'home:admin' }]);
    return { text: '👁️ نظارت کاربران KageCatch\n\n' + (lines.join('\n\n') || 'هنوز عضوی وجود ندارد.') + '\n\nاین وضعیت، فعال‌بودن کلاینت در Core را نشان می‌دهد؛ ذخیره‌بودن نشست به‌تنهایی به معنی اجرای کلاینت نیست.', keyboard: { inline_keyboard: rows } };
  }
  const monitorUser = data.match(/^owner:monitor:user:(\d+)$/);
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
    return { text: '👤 جزئیات کاربر\n\nشناسه: ' + telegramUserId + '\nنام: ' + (user.firstName || 'ثبت نشده') + '\nنام کاربری: ' + (user.username ? '@' + user.username : 'ثبت نشده') + '\nوضعیت دسترسی: ' + user.status + '\nوضعیت حساب: ' + state + '\nنشست ذخیره‌شده: ' + (account ? (account.session_saved ? 'بله' : 'خیر') : 'نامشخص') + '\n\n📜 آخرین فعالیت‌ها\n' + history, keyboard: { inline_keyboard: [[{ text: '⬅️ بازگشت به نظارت', callback_data: 'owner:monitor' }], ...BACK_MENU.inline_keyboard] } };
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
  if (data === 'owner:settings') return { text: '⚙️ تنظیمات سراسری\n\nاین بخش فقط در اختیار Owner است. تغییرات عملیاتی تا اتصال Python Core غیرفعال‌اند.', keyboard: BACK_MENU };
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
  if (await handlePanelCallback(callback, env, telegramApi)) return;
  const chat = callback.message?.chat;
  if (chat?.type !== "private" || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(callback.from?.id) || chat.id !== callback.from.id) {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "این بخش فقط در گفت‌وگوی خصوصی در دسترس است.", show_alert: true });
    return;
  }
  const actor = await getTelegramUser(env, callback.from.id);
  const role = resolveRole(callback.from.id, env.OWNER_TELEGRAM_ID, actor?.role, actor?.status);
  if (role === 'BLOCKED' || role === 'DENIED') {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "⛔ دسترسی شما مجاز نیست.", show_alert: true });
    return;
  }
  if (callback.data?.startsWith('owner:') && role !== 'OWNER') {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "⛔ این بخش فقط برای Owner است.", show_alert: true });
    return;
  }
  if (typeof callback.data === "string" && callback.data.startsWith("auth:")) {
    try { await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id }); } catch {}
    const action = parseLoginCodeCallback(callback.data);
    const current = await authStateRequest(env, callback.from.id, "get");
    const state = current.state;
    if (!action || action.action === "cancel") {
      await coreRequest(env, "POST", "/v1/accounts/" + callback.from.id + "/connect/cancel");
      await authStateRequest(env, callback.from.id, "delete");
      await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: "ورود لغو شد.", reply_markup: BACK_MENU });
      return;
    }
    if (!state || state.stage !== "code" || state.expiresAt <= Date.now()) {
      await authStateRequest(env, callback.from.id, "delete");
      await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: "⏳ درخواست ورود منقضی شده. دوباره اتصال حساب را شروع کن.", reply_markup: BACK_MENU });
      return;
    }
    let code = state.code || "";
    if (action.action === "digit") {
      if (code.length < 8) code += action.digit;
      await authStateRequest(env, callback.from.id, "set", { ...state, code });
      await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: "🔐 کد ورود را وارد کن\n\n" + maskLoginCode(code) + "\n\nکد فقط به‌صورت رمزنگاری‌شده و موقت نگهداری می‌شود.", reply_markup: buildLoginCodeKeyboard() });
      return;
    }
    if (action.action === "delete") {
      code = code.slice(0, -1);
      await authStateRequest(env, callback.from.id, "set", { ...state, code });
      await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: "🔐 کد ورود را وارد کن\n\n" + maskLoginCode(code), reply_markup: buildLoginCodeKeyboard() });
      return;
    }
    if (action.action === "submit") {
      if (!/^\d{4,8}$/.test(code)) {
        await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "کد باید بین ۴ تا ۸ رقم باشد.", show_alert: true });
        return;
      }
      const result = await coreRequest(env, "POST", "/v1/accounts/" + callback.from.id + "/connect/code", { code });
      if (result.status >= 200 && result.status < 300 && result.data?.status === "password_required") {
        await authStateRequest(env, callback.from.id, "set", { stage: "password", expiresAt: Date.now() + 300000 });
        await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: "🔐 حساب شما رمز دومرحله‌ای دارد.\n\nرمز را در پیام بعدی بفرست. پیام ورودی بلافاصله برای حذف اقدام می‌شود.", reply_markup: BACK_MENU });
        return;
      }
      if (result.status >= 200 && result.status < 300 && ["connected", "authorized"].includes(result.data?.status)) {
        await authStateRequest(env, callback.from.id, "delete");
        await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: result.data.status === "connected" ? "✅ حساب تلگرام با موفقیت متصل شد." : "✅ نشست تلگرام ذخیره شد؛ اما فعال‌شدن کلاینت نیازمند بررسی Core است.", reply_markup: BACK_MENU });
        return;
      }
      const pendingStatus = await coreRequest(env, "GET", "/v1/accounts/" + callback.from.id + "/connect/status");
      if (pendingStatus.status === 200 && pendingStatus.data?.status !== "pending") {
        await authStateRequest(env, callback.from.id, "delete");
        await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: "⏳ تلاش‌های ورود پایان یافت یا درخواست منقضی شد. دوباره اتصال حساب را شروع کن.", reply_markup: BACK_MENU });
        return;
      }
      const nextCode = result.status === 400 ? "" : code;
      await authStateRequest(env, callback.from.id, "set", { ...state, code: nextCode });
      await telegramApi(env, "editMessageText", { chat_id: chat.id, message_id: callback.message.message_id, text: result.status === 400 ? "❌ کد اشتباه است. دوباره وارد کن.\n\n" + maskLoginCode("") : "⚠️ ارتباط با Core برقرار نشد؛ دوباره تلاش کن.", reply_markup: buildLoginCodeKeyboard() });
      return;
    }
  }
  // Acknowledge before Core/Durable Object work so Telegram does not time out long monitoring callbacks.
  try { await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id }); } catch {}
  try { await registryRequest(env, '/activity/record', { telegramUserId: callback.from.id, action: callback.data || 'message', firstName: callback.from.first_name, username: callback.from.username }); } catch {}
  let result;
  if (callback.data === "home:panel") {
    result = { text: "🧩 پنل کاربری KageCatch\n\nیک بخش را انتخاب کن:", keyboard: buildRoleMenu(role) };
  } else if (callback.data === "home:admin" && role === "OWNER") {
    result = { text: "👑 پنل مدیریت KageCatch\n\nبخش مدیریتی موردنظرت را انتخاب کن:", keyboard: buildRoleMenu("OWNER") };
  } else if (callback.data === "home:status") {
    result = { text: "📊 وضعیت KageCatch\n\nControl Worker: فعال\nPython Core: متصل نیست\nاتصال حساب: هنوز فعال نشده\nاجرای Catch: غیرفعال", keyboard: { inline_keyboard: [[{ text: "⬅️ منوی شروع", callback_data: "menu:main" }]] } };
  } else if (callback.data === "home:help") {
    result = { text: "❓ راهنمای KageCatch\n\nبرای ورود به امکانات، پنل کاربری را انتخاب کن. دستورهای /panel و /status هم میانبر هستند.", keyboard: { inline_keyboard: [[{ text: "🧩 پنل کاربری", callback_data: "home:panel" }], [{ text: "⬅️ منوی شروع", callback_data: "menu:main" }]] } };
  } else if (callback.data?.startsWith("owner:")) {
    result = await handleOwnerCallback(callback, env);
  } else {
    result = resolveCallback(callback.data);
    if (callback.data === "menu:main") {
      result = { text: "🌸 خوش آمدی به KageCatch\n\nبرای ادامه یکی از گزینه‌ها را انتخاب کن:", keyboard: buildStartMenu(role) };
    }
  }
  if (callback.data === 'account:connect') {
    await authStateRequest(env, callback.from.id, "set", { stage: "phone", expiresAt: Date.now() + 300000 });
    result = { text: "🌸 اتصال حساب تلگرام\n\nشماره تلفنت رو با پیش‌شماره کشور بفرست.\nنمونه: +98912…\n\n⏳ این درخواست ۵ دقیقه اعتبار داره.", keyboard: BACK_MENU };
  }
  if (result.alert) {
    // The callback was already acknowledged; the message itself carries the validation notice.
  }
  await telegramApi(env, "editMessageText", {
    chat_id: chat.id,
    message_id: callback.message.message_id,
    text: result.text,
    reply_markup: result.keyboard,
  });
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
        if (String(message.from.id) === String(env.OWNER_TELEGRAM_ID || '') && /^\d+$/.test(String(env.OWNER_TELEGRAM_ID || ''))) {
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
        const reply = role === 'BLOCKED' || role === 'DENIED'
          ? { text: actor ? "⛔ دسترسی شما به KageCatch فعال نیست. با Owner تماس بگیر." : "🔐 برای ورود به KageCatch به لینک دعوت نیاز داری. از Owner درخواست دعوت کن." }
          : { text: role === 'OWNER' ? "🌸 خوش آمدی Owner؛ پنل مدیریت آماده‌ست." : "🌸 دعوتت تأیید شد! به KageCatch خوش اومدی 😎", reply_markup: command === "/start" ? buildStartMenu(role) : buildRoleMenu(role) };
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
    const authSnapshot = await authStateRequest(env, message.from.id, "get");
    const authState = authSnapshot.state;
    if (authState && authState.expiresAt <= Date.now()) await authStateRequest(env, message.from.id, "delete");
    else if (authState?.stage === "phone") {
      if (command === "/cancel") {
        await authStateRequest(env, message.from.id, "delete");
        await telegramApi(env, "deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
        await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "ورود لغو شد.", reply_markup: BACK_MENU });
        return new Response("OK", { status: 200 });
      }
      try {
        await telegramApi(env, "deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
        if (!validatePhoneNumber(message.text)) throw new Error("invalid_phone");
        const status = await beginTelegramLogin(env, message.from.id, message.text);
        if (status === "connected") {
          await authStateRequest(env, message.from.id, "delete");
          await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "✅ حساب تلگرام شما از قبل مجاز بود و اتصال برقرار شد.", reply_markup: BACK_MENU });
        } else if (status === "reauthorization_required") {
          await authStateRequest(env, message.from.id, "delete");
          await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ برای این حساب نشست قبلی وجود دارد اما تلگرام ورود مجدد می‌خواهد. ابتدا نشست قبلی را از بخش امنیت لغو کن و دوباره اتصال را شروع کن.", reply_markup: BACK_MENU });
        } else {
          await authStateRequest(env, message.from.id, "set", { stage: "code", code: "", expiresAt: Date.now() + 300000 });
          await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "🔐 کد ورود را با صفحه‌کلید زیر وارد کن.\n\n" + maskLoginCode(""), reply_markup: buildLoginCodeKeyboard() });
        }
      } catch (error) {
        await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: error.message === "invalid_phone" ? "شماره معتبر نیست. با فرمت بین‌المللی مثل +98912… بفرست." : "❌ درخواست کد انجام نشد. دوباره تلاش کن.", reply_markup: BACK_MENU });
      }
      return new Response("OK", { status: 200 });
    } else if (authState?.stage === "password") {
      if (command === "/cancel") {
        await authStateRequest(env, message.from.id, "delete");
        await coreRequest(env, "POST", "/v1/accounts/" + message.from.id + "/connect/cancel");
        await telegramApi(env, "deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
        await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "ورود لغو شد.", reply_markup: BACK_MENU });
        return new Response("OK", { status: 200 });
      }
      try {
        await telegramApi(env, "deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
        const result = await coreRequest(env, "POST", "/v1/accounts/" + message.from.id + "/connect/password", { password: message.text });
        if (result.status >= 200 && result.status < 300 && result.data?.status === "connected") {
          await authStateRequest(env, message.from.id, "delete");
          await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "✅ حساب تلگرام با موفقیت متصل شد.", reply_markup: BACK_MENU });
        } else {
          const pendingStatus = await coreRequest(env, "GET", "/v1/accounts/" + message.from.id + "/connect/status");
          if (pendingStatus.status === 200 && pendingStatus.data?.status !== "pending") {
            await authStateRequest(env, message.from.id, "delete");
            await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⏳ تلاش‌های ورود پایان یافت یا درخواست منقضی شد. دوباره اتصال حساب را شروع کن.", reply_markup: BACK_MENU });
          } else {
            await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ رمز دومرحله‌ای تأیید نشد. دوباره تلاش کن یا /cancel را بزن.", reply_markup: BACK_MENU });
          }
        }
      } catch {
        await telegramApi(env, "deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
        await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ اتصال به Core ناموفق بود. دوباره تلاش کن." });
      }
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
  try { candidates = JSON.parse(row.candidates_json); } catch { throw new Error("invalid stored candidates"); }
  if (!Array.isArray(candidates)) throw new Error("invalid stored candidates");
  return {
    review_id: row.review_id,
    user_id: row.user_id,
    spawn_id: row.spawn_id,
    anime_name: row.anime_name,
    candidates,
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
      const { review_id, user_id, spawn_id, anime_name, candidates, created_at, expires_at } = payload;
      if (typeof review_id !== "string" || !/^[a-f0-9]{32}$/.test(review_id)
        || typeof user_id !== "string" || !user_id || user_id.length > 128
        || !Number.isSafeInteger(spawn_id) || spawn_id < 0
        || typeof anime_name !== "string" || !anime_name.trim() || anime_name.length > 300
        || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 30
        || candidates.some((name) => typeof name !== "string" || !name.trim() || name.length > 100)
        || typeof created_at !== "string" || typeof expires_at !== "string"
        || !Number.isFinite(Date.parse(created_at)) || !Number.isFinite(Date.parse(expires_at))
        || Date.parse(expires_at) <= Date.parse(created_at)) return json({ error: "invalid_review_item" }, 400);
      const inserted = await env.KAGECATCH_DB.prepare(
        "INSERT INTO manual_review_items (review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, status, selected_character) SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', NULL WHERE (SELECT COUNT(*) FROM manual_review_items WHERE user_id = ? AND status = 'pending' AND expires_at > ?) < 100"
      ).bind(review_id, user_id, spawn_id, anime_name.trim(), JSON.stringify(candidates), new Date(created_at).toISOString(), new Date(expires_at).toISOString(), user_id, now).run();
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
        "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE user_id = ? AND status = 'pending' ORDER BY created_at, review_id LIMIT 100"
      ).bind(payload.user_id).all();
      return json({ items: (result?.results || []).map(reviewRowToItem) });
    }

    if (payload.action === "approve" || payload.action === "reject") {
      const { user_id, review_id } = payload;
      if (typeof user_id !== "string" || !user_id || user_id.length > 128
        || typeof review_id !== "string" || !/^[a-f0-9]{32}$/.test(review_id)) return json({ error: "invalid_review_id" }, 400);
      const row = await env.KAGECATCH_DB.prepare(
        "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE review_id = ? AND user_id = ?"
      ).bind(review_id, user_id).first();
      if (!row) return json({ error: "review_item_not_found" }, 404);
      if (row.status !== "pending") return json({ error: "review_item_already_resolved" }, 409);
      if (Date.parse(row.expires_at) <= Date.parse(now)) {
        await env.KAGECATCH_DB.prepare(
          "UPDATE manual_review_items SET status = 'expired' WHERE review_id = ? AND user_id = ? AND status = 'pending'"
        ).bind(review_id, user_id).run();
        const expiredRow = await env.KAGECATCH_DB.prepare(
          "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE review_id = ? AND user_id = ?"
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
        "SELECT review_id, user_id, spawn_id, anime_name, candidates_json, created_at, expires_at, status, selected_character FROM manual_review_items WHERE review_id = ? AND user_id = ?"
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
    if (url.pathname === WEBHOOK_PATH) return handleWebhook(request, env);
    return json({ error: "not_found" }, 404);
  },
};