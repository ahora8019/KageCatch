const WEBHOOK_PATH = "/webhook";
const MAX_BODY_BYTES = 256 * 1024;
const VERSION = "0.6.0";
const CONNECTION_LINK_TTL_SECONDS = 300;
const CONNECTION_LINK_BASE = "https://kagecatch-control.ahora-project.workers.dev";
const PANEL_URL = "https://kagecatch-control.ahora-project.workers.dev/panel";

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
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > 300) return null;
  const checkString = entries
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + "=" + value)
    .join("\\n");
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
    status: actor.status,
    core_status: "not_connected",
    account_status: "not_connected",
  });
}
\nasync function telegramApi(env, method, payload = {}) {
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
    [{ text: "🌸 پنل حرفه‌ای", web_app: { url: PANEL_URL } }],
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
    [{ text: "🌸 پنل حرفه‌ای", web_app: { url: PANEL_URL } }],
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
  const html = \`<!doctype html><html lang="fa" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#100e17"><title>KageCatch | Dashboard</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#100e17;color:#f7f0fa;--panel:#1a1722;--line:#382e40;--pink:#ed9dcc;--muted:#a99db0;--green:#82d5ae;--amber:#e8bd75}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 80% 0,#48233e 0,transparent 40%),#100e17}
button{font:inherit;color:inherit;cursor:pointer}.shell{max-width:1380px;margin:auto;padding:22px;display:grid;grid-template-columns:230px 1fr;gap:20px}
aside{height:calc(100vh - 44px);min-height:600px;position:sticky;top:22px;background:#1a1722eF;border:1px solid var(--line);border-radius:22px;padding:20px 14px;display:flex;flex-direction:column}
.brand{display:flex;gap:11px;align-items:center;padding:5px 7px 25px}.logo{width:42px;height:42px;border-radius:14px;background:linear-gradient(140deg,#f2b5da,#a96d9e);display:grid;place-items:center;color:#261629;font-size:22px}.brand b{letter-spacing:.12em;font-size:15px}.brand small{display:block;color:var(--muted);font-size:9px;letter-spacing:.16em;margin-top:3px}
.nav-label{color:#796f83;font-size:10px;letter-spacing:.13em;padding:12px}.nav{display:grid;gap:5px}.nav button{background:none;border:1px solid transparent;border-radius:12px;padding:12px;text-align:right;color:#b9adbf;font-size:12px}.nav button.active,.nav button:hover{background:#302438;border-color:#4a364c;color:#ffe4f3}.nav button.active{box-shadow:inset -2px 0 var(--pink)}.profile{margin-top:auto;border-top:1px solid var(--line);padding:16px 8px 0;color:var(--muted);font-size:10px;line-height:1.9}
main{min-width:0}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:4px 0 24px}.eyebrow{font-size:10px;letter-spacing:.16em;color:var(--pink)}h1{font-size:clamp(23px,3vw,32px);margin:7px 0}p{color:var(--muted);font-size:12px;margin:0;line-height:1.9}.pill{border:1px solid #385646;background:#1b2b24;color:var(--green);border-radius:99px;padding:9px 12px;font-size:10px;white-space:nowrap}
.view{display:none}.view.active{display:block}.hero{padding:24px;border:1px solid #583a51;border-radius:20px;background:linear-gradient(115deg,#38243a,#211b2b 75%);margin-bottom:15px;position:relative;overflow:hidden}.hero:after{content:"🌸";position:absolute;left:25px;top:5px;font-size:90px;opacity:.1}.hero h2{font-size:20px;margin:8px 0}.actions{display:flex;gap:9px;margin-top:15px;flex-wrap:wrap}.primary,.secondary{border-radius:11px;padding:10px 14px;font-size:11px;border:1px solid transparent}.primary{background:var(--pink);color:#291927;font-weight:700}.secondary{background:#ffffff08;border-color:#59455c}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:15px}.stat,.card{background:#1a1722;border:1px solid var(--line);border-radius:16px;padding:16px}.stat label{font-size:10px;color:var(--muted)}.stat strong{display:block;font-size:25px;margin:12px 0 3px}.stat small{font-size:9px;color:#8d8297}
.columns{display:grid;grid-template-columns:1.2fr 1fr;gap:13px}.card h3{font-size:13px;margin:0 0 14px}.service,.target{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#15131c;border:1px solid #302938;border-radius:12px;padding:12px;margin-top:9px}.service b,.target b{display:block;font-size:11px}.service small,.target small{display:block;color:var(--muted);font-size:9px;margin-top:4px}.tag{font-size:9px;border-radius:99px;padding:6px 8px;white-space:nowrap}.ok{background:#1d3028;color:var(--green)}.wait{background:#352b20;color:var(--amber)}.off{background:#30232a;color:#d9a0ad}
.empty{padding:34px 12px;text-align:center;color:var(--muted);font-size:11px;line-height:2}.empty b{display:block;color:#f2e4f4;font-size:13px;margin:8px}.notice{margin-top:13px;padding:13px;background:#241c2b;border:1px solid #4a394e;border-radius:12px;color:#cdbfd1;font-size:10px;line-height:1.9}
footer{display:flex;justify-content:space-between;color:#776d80;font-size:9px;padding:20px 3px}.mobile{display:none}
@media(max-width:850px){.shell{display:block;padding:15px}aside{display:none}.stats{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}.mobile{display:flex;position:fixed;z-index:5;bottom:9px;left:9px;right:9px;justify-content:space-around;background:#211b2bf2;border:1px solid #4a394e;border-radius:16px;padding:8px;backdrop-filter:blur(16px)}.mobile button{border:0;background:none;color:#b9adbf;font-size:10px;display:grid;gap:3px}.mobile button.active{color:var(--pink)}main{padding-bottom:80px}}
@media(max-width:480px){.shell{padding:12px}.top{margin:3px 0 15px}.top h1{font-size:22px}.hero{padding:18px}.hero h2{font-size:17px}.stat,.card{padding:13px}.stat strong{font-size:22px}.pill{font-size:9px;padding:8px}}
</style></head><body>
<div class="shell"><aside aria-label="ناوبری اصلی">
<div class="brand"><div class="logo">🌸</div><div><b>KAGECATCH</b><small>CONTROL CENTER</small></div></div>
<div class="nav-label">WORKSPACE</div><nav class="nav" aria-label="بخش‌های پنل">
<button class="active" data-view="overview">⌂　نمای کلی</button><button data-view="accounts">♙　حساب‌های متصل</button><button data-view="catcher">✧　تنظیمات Catch</button><button data-view="activity">◷　تاریخچه عملیات</button><button data-view="security">⬡　امنیت و نشست‌ها</button><button data-view="settings">⚙　تنظیمات</button></nav>
<div class="nav-label">MANAGEMENT</div><nav class="nav"><button data-view="admin" id="admin-nav" hidden>♛　مدیریت سامانه</button></nav>
<div class="profile"><b id="profile-name">حساب تلگرام</b><br><span id="profile-role">برای ورود از داخل بات باز کن</span></div></aside>
<main><header class="top"><div><div class="eyebrow">KAGECATCH / DASHBOARD</div><h1 id="title">داشبورد کنترل</h1><p>مرکز مدیریت حساب‌ها و عملیات Catch</p></div><span class="pill" id="health">● در حال بررسی اتصال</span></header>
<section class="view active" id="view-overview">
<div class="hero"><div class="eyebrow">WELCOME TO KAGECATCH</div><h2>همه‌چیز برای شروع آماده می‌شود.</h2><p>حساب‌ها، مقصدهای Catch، عملکرد و امنیت نشست‌ها را از یک مرکز مدیریت کن. اتصال حساب و اجرای خودکار پس از راه‌اندازی امن Python Core فعال می‌شود.</p><div class="actions"><button class="primary" data-view="accounts">مدیریت حساب‌ها</button><button class="secondary" data-view="catcher">تنظیمات Catch</button></div></div>
<div class="stats">
<div class="stat"><label>حساب‌های متصل</label><strong>—</strong><small>پس از اتصال Core</small></div>
<div class="stat"><label>Catch امروز</label><strong>—</strong><small>هنوز عملیات زنده ثبت نشده</small></div>
<div class="stat"><label>نرخ موفقیت</label><strong>—</strong><small>نیازمند داده تأییدشده</small></div>
<div class="stat"><label>Python Core</label><strong id="core">Offline</strong><small>اتصال در مرحله بعد</small></div></div>
<div class="columns"><section class="card"><h3>وضعیت اجزای سامانه</h3>
<div class="service"><div><b>Control Worker</b><small>درگاه کنترل تلگرام</small></div><span class="tag wait" id="worker-tag">در حال بررسی</span></div>
<div class="service"><div><b>Python Core</b><small>مدیریت نشست و اجرای Catch</small></div><span class="tag off">متصل نیست</span></div>
<div class="service"><div><b>Recognition Engine</b><small>تشخیص تصویر و ویدیو</small></div><span class="tag off">در انتظار توسعه</span></div>
<div class="service"><div><b>Catch Engine</b><small>ارسال و تأیید عملیات</small></div><span class="tag wait">آماده‌سازی</span></div></section>
<section class="card"><h3>بات‌های مقصد</h3>
<div class="target"><div><b>HentaCatcherBot</b><small>Image · /catch</small></div><span class="tag ok">پیکربندی‌شده</span></div>
<div class="target"><div><b>Character_Catcher_Bot</b><small>Image · /catch</small></div><span class="tag ok">پیکربندی‌شده</span></div>
<div class="target"><div><b>SenpaiCatcherBot</b><small>Video · /pick</small></div><span class="tag off">متوقف</span></div></section></div></section>
<section class="view" id="view-accounts"><div class="card"><h3>حساب‌های تلگرام</h3><div class="empty">♙<b>هنوز حسابی متصل نشده است</b>اتصال امن پس از تکمیل handoff رسمی تلگرام و API هسته اجرایی فعال می‌شود.<br>کد ورود یا رمز دومرحله‌ای را در بات یا این صفحه وارد نکن.</div></div></section>
<section class="view" id="view-catcher"><div class="card"><h3>تنظیمات Catch</h3><div class="service"><div><b>حداقل اطمینان تشخیص</b><small>Confidence threshold</small></div><span class="tag wait">قفل‌شده</span></div><div class="service"><div><b>محدودیت عملیات</b><small>Quota per account</small></div><span class="tag wait">قفل‌شده</span></div><div class="service"><div><b>جلوگیری از تکرار</b><small>Duplicate protection</small></div><span class="tag wait">در انتظار Core</span></div><div class="service"><div><b>تأیید نتیجه</b><small>Target response verifier</small></div><span class="tag wait">در انتظار Core</span></div><div class="notice">این تنظیمات تا اتصال Core فقط نمایشی‌اند و هیچ عملیات Catch اجرا نمی‌کنند.</div></div></section>
<section class="view" id="view-activity"><div class="card"><h3>تاریخچه عملیات</h3><div class="empty">◷<b>هنوز رویدادی ثبت نشده است</b>پس از راه‌اندازی Core، نتیجه تأییدشده هر عملیات اینجا نمایش داده می‌شود.</div></div></section>
<section class="view" id="view-security"><div class="card"><h3>امنیت و نشست‌ها</h3><div class="service"><div><b>رمزنگاری Session</b><small>Fernet encryption at rest</small></div><span class="tag wait">نیازمند Core</span></div><div class="service"><div><b>مدیریت نشست‌ها</b><small>قطع و لغو دسترسی</small></div><span class="tag wait">نیازمند Core</span></div><div class="service"><div><b>گزارش دسترسی</b><small>Audit trail</small></div><span class="tag wait">نیازمند Core</span></div><div class="notice">کد ورود، رمز دومرحله‌ای و StringSession از طریق چت بات دریافت نمی‌شوند.</div></div></section>
<section class="view" id="view-settings"><div class="card"><h3>تنظیمات عمومی</h3><div class="empty">⚙<b>تنظیمات هنوز فعال نیستند</b>زبان، اعلان‌ها و ترجیحات Catch پس از احراز هویت Mini App فعال می‌شوند.</div></div></section>
<section class="view" id="view-admin"><div class="card"><h3>مدیریت سامانه</h3><div class="empty">♛<b>بخش مدیریت محافظت شده است</b>نقش Owner باید از داده معتبر تلگرام و سمت سرور تعیین شود؛ احراز هویت Mini App در مرحله بعد متصل می‌شود.</div></div></section>
<footer><span>KageCatch · Control Center</span><span>Worker v0.6.0 · UI foundation</span></footer></main></div>
<nav class="mobile" aria-label="ناوبری موبایل"><button class="active" data-view="overview">⌂<span>خانه</span></button><button data-view="accounts">♙<span>حساب‌ها</span></button><button data-view="catcher">✧<span>Catch</span></button><button data-view="activity">◷<span>رویدادها</span></button><button data-view="security">⬡<span>امنیت</span></button></nav>
<script>
const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();}
let session=null;
const titles={overview:"داشبورد کنترل",accounts:"حساب‌های متصل",catcher:"تنظیمات Catch",activity:"تاریخچه عملیات",security:"امنیت و نشست‌ها",settings:"تنظیمات",admin:"مدیریت سامانه"};
function showView(name){if(name==="admin"&&session?.role!=="OWNER"){name="overview";}document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.id==="view-"+name));document.querySelectorAll("[data-view]").forEach(x=>x.classList.toggle("active",x.dataset.view===name));document.querySelector("#title").textContent=titles[name]||titles.overview;window.scrollTo({top:0,behavior:"smooth"});}
document.querySelectorAll("[data-view]").forEach(x=>x.addEventListener("click",()=>showView(x.dataset.view)));
async function authenticate(){const name=document.querySelector("#profile-name"),role=document.querySelector("#profile-role");if(!tg?.initData){name.textContent="ورود از داخل تلگرام";role.textContent="پنل را از دکمه بات باز کن";return;}try{const response=await fetch("/api/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({initData:tg.initData}),cache:"no-store"});if(!response.ok)throw new Error("auth");session=await response.json();name.textContent=session.user.first_name||"کاربر KageCatch";role.textContent=session.role==="OWNER"?"مالک سامانه":"عضو فعال";if(session.role==="OWNER")document.querySelector("#admin-nav").hidden=false;}catch{name.textContent="احراز هویت ناموفق";role.textContent="از /start در بات دوباره وارد شو";}}
async function refresh(){const pill=document.querySelector("#health"),tag=document.querySelector("#worker-tag");try{const r=await fetch("/health",{cache:"no-store"});const s=await r.json();const ok=r.ok&&s.status==="webhook_ready";pill.textContent=ok?"● Control Plane فعال":"● نیازمند بررسی";pill.style.color=ok?"var(--green)":"var(--amber)";tag.textContent=ok?"فعال":"اختلال";tag.className="tag "+(ok?"ok":"wait");}catch{pill.textContent="● عدم دسترسی";tag.textContent="نامشخص";tag.className="tag off";}}
authenticate();refresh();
</script></body></html>\`;
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
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
    if (url.pathname === "/health" && request.method === "GET") return health(env);\n    if (url.pathname === "/api/session") return miniAppSession(request, env);
    if (url.pathname === "/panel" && request.method === "GET") return panelPage();
    if (url.pathname.startsWith("/connect/")) return connectionLanding(request, env, decodeURIComponent(url.pathname.slice("/connect/".length)));
    if (url.pathname === WEBHOOK_PATH) return handleWebhook(request, env);
    return json({ error: "not_found" }, 404);
  },
};