const WEBHOOK_PATH = "/webhook";
const MAX_BODY_BYTES = 256 * 1024;
const VERSION = "0.5.0";
const CONNECTION_LINK_TTL_SECONDS = 300;
const CONNECTION_LINK_BASE = "https://kagecatch-control.ahora-project.workers.dev";

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
    [{ text: "🟢 اتصال حساب", callback_data: "account:connect" }],
    [{ text: "👤 حساب‌های متصل من", callback_data: "account:list" }],
    [{ text: "📊 آمار من", callback_data: "stats:open" }, { text: "🔒 امنیت حساب من", callback_data: "security:open" }],
    [{ text: "❌ قطع اتصال حساب من", callback_data: "account:disconnect" }],
    [{ text: "❓ راهنما", callback_data: "help:open" }],
  ];
  if (role === "OWNER") return { inline_keyboard: [
    [{ text: "👑 نظارت کل سامانه", callback_data: "owner:stats" }],
    [{ text: "👥 مدیریت اعضا", callback_data: "owner:members" }],
    [{ text: "⚙️ تنظیمات سراسری", callback_data: "owner:settings" }],
    [{ text: "📣 پیام همگانی", callback_data: "owner:broadcast" }],
    [{ text: "🛑 توقف اضطراری", callback_data: "owner:emergency" }],
    ...memberRows,
  ] };
  return { inline_keyboard: memberRows };
}

export function buildMainMenu() { return buildRoleMenu("MEMBER"); }

export function buildStartMenu(role = "MEMBER") {
  const rows = [
    [{ text: "🧩 پنل کاربری", callback_data: "home:panel" }],
    [{ text: "📊 وضعیت سرویس", callback_data: "home:status" }],
    [{ text: "❓ راهنما", callback_data: "home:help" }],
  ];
  if (role === "OWNER") rows.unshift([{ text: "👑 پنل مدیریت", callback_data: "home:admin" }]);
  return { inline_keyboard: rows };
}

export function resolveRole(userId, ownerTelegramId, storedRole = "MEMBER", status = "active") {
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
        text: "🟢 اتصال حساب\n\nاتصال امن هنوز فعال نشده است. برای محافظت از حساب، KageCatch کد ورود تلگرام یا رمز دومرحله‌ای را از طریق چت دریافت نمی‌کند.\n\nتا آماده‌شدن روش اتصال امن، هیچ کد ورود یا رمز دومرحله‌ای را اینجا ارسال نکن.",
        keyboard: BACK_MENU,
      };
    case "account:list":
      return { text: "👤 حساب‌های متصل\n\nفعلاً حسابی ثبت نشده است؛ هسته اجرایی هنوز متصل نیست.", keyboard: BACK_MENU };
    case "settings:open":
      return {
        text: "⚙️ تنظیمات\n\nتنظیمات حساب و Catch پس از اتصال هسته اجرایی فعال می‌شوند.",
        keyboard: BACK_MENU,
      };
    case "stats:open":
      return { text: "📊 آمار و عملکرد\n\nهنوز داده‌ای برای نمایش وجود ندارد؛ اجرای Catch فعال نیست.", keyboard: BACK_MENU };
    case "security:open":
      return {
        text: "🔒 امنیت و نشست‌ها\n\nهیچ کد ورود یا رمز دومرحله‌ای در بات دریافت نمی‌شود. نشست‌های ذخیره‌شده باید رمزنگاری شوند و امکان لغو دسترسی داشته باشند.\n\nحذف پیام فقط بهترین تلاش است و حذف کامل از زیرساخت تلگرام را تضمین نمی‌کند.",
        keyboard: BACK_MENU,
      };
    case "account:disconnect":
      return { text: "❌ حساب متصلی ثبت نشده است.", keyboard: BACK_MENU };
    case "help:open":
      return {
        text: "❓ راهنمای KageCatch\n\nاز دکمه‌های منوی اصلی برای مدیریت حساب، تنظیمات، آمار و امنیت استفاده کن.\nدستورهای /status و /help هم به‌عنوان میانبر در دسترس‌اند.",
        keyboard: BACK_MENU,
      };
    case "menu:main":
      return { text: "🌸 خوش آمدی به KageCatch\n\nاز گزینه‌های زیر یکی را انتخاب کن:", keyboard: buildStartMenu() };
    default:
      return { text: "این گزینه معتبر نیست. منوی اصلی را دوباره باز کن.", keyboard: BACK_MENU, alert: true };
  }
}

export function commandReply(text) {
  const command = (text || "").trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start") {
    return {
      text: "🌸 خوش آمدی به KageCatch\n\nبرای ادامه یکی از گزینه‌ها را انتخاب کن:",
      reply_markup: buildStartMenu(),
    };
  }
  if (command === "/panel") {
    return {
      text: "🧩 پنل کاربری KageCatch\n\nیک بخش را انتخاب کن:",
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
      text: "📖 راهنمای KageCatch\n\nدکمه‌های منوی اصلی برای کارهای روزمره هستند.\n/status — وضعیت سرویس\n/help — راهنما\n/admin — بخش مدیریت (تا زمان پیکربندی مالک غیرفعال است).",
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
    const [webhook, bot] = await Promise.all([
      telegramApi(env, "getWebhookInfo"),
      telegramApi(env, "getMe"),
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
      python_core: "not_connected",
      version: VERSION,
    });
  } catch {
    return json({ service: "KageCatch Control", status: "degraded", webhook_auth: "enabled", version: VERSION }, 503);
  }
}

function panelPage() {
  return new Response(`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#111018"><title>KageCatch Control</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#111018;color:#f6f0fa}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 80% 0,#3b1837 0,transparent 45%),#111018}
main{max-width:850px;margin:auto;padding:36px 20px}.brand{color:#f5a6d6;letter-spacing:.08em;font-size:13px}
h1{font-size:clamp(28px,6vw,44px);margin:8px 0}.sub{color:#bcb4c5;margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
.card{border:1px solid #3a3041;background:#1b1722;border-radius:16px;padding:20px}
.label{color:#bcb4c5;font-size:13px}.value{font-size:19px;margin-top:8px;font-weight:650}
.status{display:inline-block;width:9px;height:9px;border-radius:50%;background:#e9b75c;margin-left:8px}
.note{margin-top:20px;padding:16px;border-right:3px solid #e78cc5;background:#211a28;border-radius:8px;color:#d7cddd;line-height:1.9}
footer{margin-top:28px;color:#817889;font-size:12px}
</style></head><body><main>
<div class="brand">KAGECATCH / CONTROL PLANE</div><h1>پنل کنترل KageCatch</h1>
<p class="sub">وضعیت سرویس کنترل تلگرام و هستهٔ اجرایی</p>
<section class="grid">
<div class="card"><div class="label">وضعیت Worker</div><div class="value" id="worker"><span class="status"></span>در حال بررسی…</div></div>
<div class="card"><div class="label">اتصال Webhook</div><div class="value" id="webhook">در حال بررسی…</div></div>
<div class="card"><div class="label">بات تلگرام</div><div class="value" id="bot">در حال بررسی…</div></div>
<div class="card"><div class="label">Python Core</div><div class="value" id="core">هنوز متصل نیست</div></div>
</section>
<div class="note">این پنل فعلاً وضعیت Control Plane را نمایش می‌دهد. اجرای Catch و مدیریت نشست‌ها تا اتصال امن Python Core فعال نیست.</div>
<footer>KageCatch · Worker v${VERSION}</footer></main>
<script>
fetch('/health',{cache:'no-store'}).then(r=>r.json()).then(s=>{
document.querySelector('#worker').textContent=s.status||'نامشخص';
document.querySelector('#webhook').textContent=s.telegram_webhook||'نامشخص';
document.querySelector('#bot').textContent=s.bot?.username?'@'+s.bot.username:'نامشخص';
document.querySelector('#core').textContent=s.python_core==='connected'?'متصل':'هنوز متصل نیست';
}).catch(()=>{document.querySelector('#worker').textContent='عدم دسترسی';});
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}

export class ConnectionLinkStore {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    const url = new URL(request.url);
    let body;
    try { if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new Error('content type'); body = await request.json(); }
    catch { return json({ error: 'invalid_request' }, 400); }
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
      const record = await this.state.storage.transaction(async (txn) => {
        const value = await txn.get(key);
        if (value) await txn.delete(key);
        return value;
      });
      if (!record) return json({ error: 'invalid_or_used_link' }, 410);
      if (record.expiresAt <= Date.now()) return json({ error: 'expired_link' }, 410);
      return json({ valid: true }, 200);
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
  if (!response.ok) throw new Error('User registry unavailable');
  return response.json();
}

async function getTelegramUser(env, userId) {
  const result = await registryRequest(env, '/user', { telegramUserId: userId });
  return result.user;
}

async function handleOwnerCallback(callback, env) {
  const data = callback.data || '';
  if (data === 'owner:stats') return { text: '👑 نظارت کل سامانه\n\nنمای کلی کاربران و سرویس‌ها در حال آماده‌سازی است.', keyboard: BACK_MENU };
  if (data === 'owner:settings') return { text: '⚙️ تنظیمات سراسری\n\nاین بخش فقط در اختیار Owner است. تغییرات عملیاتی تا اتصال Python Core غیرفعال‌اند.', keyboard: BACK_MENU };
  if (data === 'owner:broadcast') {
    await registryRequest(env, '/broadcast', { ownerTelegramId: callback.from.id, action: 'begin' });
    return {
      text: '📣 پیام همگانی\n\nمتن پیام را در همین چت بفرست. قبل از ارسال، پیش‌نمایش می‌بینی و باید تأیید کنی.',
      keyboard: { inline_keyboard: [[{ text: 'لغو', callback_data: 'owner:broadcast:cancel' }]] },
    };
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
    let delivered = 0;
    let failed = 0;
    for (const recipient of recipients) {
      try {
        await telegramApi(env, 'sendMessage', { chat_id: recipient.telegramUserId, text: messageText });
        delivered += 1;
      } catch {
        failed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await registryRequest(env, '/broadcast', { ownerTelegramId: callback.from.id, action: 'clear' });
    return {
      text: '📣 ارسال همگانی تمام شد.\n\nموفق: ' + delivered + '\nناموفق: ' + failed + '\nمخاطبان فعال: ' + recipients.length,
      keyboard: BACK_MENU,
    };
  }
  if (data === 'owner:emergency') return { text: '🛑 توقف اضطراری\n\nCatch در حال حاضر فعال نیست؛ هیچ عملیات زنده‌ای برای توقف وجود ندارد.', keyboard: BACK_MENU };
  if (data === 'owner:members') {
    const result = await registryRequest(env, '/users', {});
    const users = result.users || [];
    const lines = users.map((u) => '• ' + u.telegramUserId + ' — ' + u.role + ' — ' + u.status);
    const keyboard = users.filter((u) => u.role !== 'OWNER').slice(0, 20).map((u) => [{
      text: (u.status === 'blocked' ? '🔓 آزادسازی ' : '🚫 مسدودسازی ') + u.telegramUserId,
      callback_data: 'owner:' + (u.status === 'blocked' ? 'unblock:' : 'block:') + u.telegramUserId,
    }]);
    keyboard.push([{ text: '⬅️ منوی اصلی', callback_data: 'menu:main' }]);
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
  const chat = callback.message?.chat;
  if (chat?.type !== "private" || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(callback.from?.id)) {
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
    try {
      const link = await createConnectionLink(env, callback.from.id);
      result = { text: 'لینک اختصاصی ساخته شد؛ فقط یک‌بار و تا ۵ دقیقه معتبر است. این مرحله فقط اعتبار لینک را بررسی می‌کند؛ ورود به حساب و ساخت Session هنوز فعال نشده است. هیچ کد ورود یا رمز دومرحله‌ای را در بات یا این صفحه وارد نکن.', keyboard: { inline_keyboard: [[{ text: 'باز کردن لینک اختصاصی', url: link }], [{ text: 'منوی اصلی', callback_data: 'menu:main' }]] } };
    } catch { result = { text: 'سرویس لینک هنوز پیکربندی نشده است؛ فعلاً امکان ساخت لینک وجود ندارد.', keyboard: BACK_MENU }; }
  }
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    ...(result.alert ? { text: result.text, show_alert: true } : {}),
  });
  await telegramApi(env, "editMessageText", {
    chat_id: chat.id,
    message_id: callback.message.message_id,
    text: result.text,
    reply_markup: result.keyboard,
  });
}

async function connectionLanding(request, env, token) {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return new Response("Invalid link", { status: 404 });
  if (request.method === "GET") {
    const html = "<!doctype html><html lang=fa dir=rtl><meta charset=utf-8><title>KageCatch</title><body><h1>اتصال KageCatch</h1><p>این لینک یک‌بارمصرف است. این مرحله فقط اعتبار لینک را بررسی می‌کند؛ ورود و ساخت Session هنوز فعال نیست. کد ورود یا رمز دومرحله‌ای وارد نکن.</p><form method=post><input type=hidden name=token value=" + token + "><button>بررسی لینک</button></form></body></html>";
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.formData();
  if (form.get("token") !== token || !env.CONNECT_LINKS) return new Response("Invalid link", { status: 410 });
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const response = await stub.fetch("https://connect-links.internal/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (!response.ok) return new Response("لینک منقضی شده یا قبلاً مصرف شده است.", { status: 410, headers: { "cache-control": "no-store" } });
  return new Response("لینک تأیید شد. این به معنی اتصال حساب تلگرام نیست؛ احراز هویت و ساخت Session هنوز فعال نشده است.", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
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
    } catch {
      return new Response("Telegram delivery failed", { status: 502 });
    }
    return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const message = update.message;
  if (message && message.chat?.type === "private" && Number.isSafeInteger(message.chat.id) && typeof message.text === "string" && Number.isSafeInteger(message.from?.id)) {
    const command = message.text.trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
    if (command === "/start" || command === "/panel") {
      try {
        const registered = await registryRequest(env, '/register', { telegramUserId: message.from.id, ownerTelegramId: env.OWNER_TELEGRAM_ID || "" });
        const role = resolveRole(message.from.id, env.OWNER_TELEGRAM_ID, registered.role, registered.status);
        const reply = role === 'BLOCKED' || role === 'DENIED'
          ? { text: "⛔ دسترسی شما به KageCatch فعال نیست. با Owner تماس بگیر." }
          : { text: role === 'OWNER' ? "🌸 خوش آمدی Owner؛ از منوی شروع بخش موردنظرت را انتخاب کن." : "🌸 خوش آمدی به KageCatch؛ برای ادامه یکی از گزینه‌ها را انتخاب کن.", reply_markup: command === "/start" ? buildStartMenu(role) : buildRoleMenu(role) };
        await telegramApi(env, "sendMessage", { chat_id: message.chat.id, ...reply });
      } catch { return new Response("User registry unavailable", { status: 503 }); }
      return new Response("OK", { status: 200 });
    }
    const actor = await getTelegramUser(env, message.from.id);
    const role = resolveRole(message.from.id, env.OWNER_TELEGRAM_ID, actor?.role, actor?.status);
    if (role === 'BLOCKED' || role === 'DENIED') {
      await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⛔ ابتدا باید دسترسی شما توسط Owner فعال شود." });
      return new Response("OK", { status: 200 });
    }
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
          const preview = draft.text.length > 3500 ? draft.text.slice(0, 3500) + '\\n… (پیش‌نمایش کوتاه‌شده)' : draft.text;
          await telegramApi(env, 'sendMessage', {
            chat_id: message.chat.id,
            text: '👀 پیش‌نمایش پیام همگانی:\\n\\n' + preview + '\\n\\nاین پیام برای اعضای فعال ارسال شود؟',
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
      await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "📊 وضعیت حساب شما در KageCatch\\n\\nنقش: MEMBER\\nدسترسی: فعال\\nمدیریت حساب‌ها و آمار شخصی از پنل در دسترس است.", reply_markup: buildRoleMenu("MEMBER") });
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

export default {
  async fetch(request, env) {    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return health(env);
    if (url.pathname === "/panel" && request.method === "GET") return panelPage();
    if (url.pathname.startsWith("/connect/")) return connectionLanding(request, env, decodeURIComponent(url.pathname.slice("/connect/".length)));
    if (url.pathname === WEBHOOK_PATH) return handleWebhook(request, env);
    return json({ error: "not_found" }, 404);
  },
};