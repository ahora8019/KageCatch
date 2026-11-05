const WEBHOOK_PATH = "/webhook";
const MAX_BODY_BYTES = 256 * 1024;
const VERSION = "0.3.0";

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

export function buildMainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🟢 اتصال حساب", callback_data: "account:connect" }],
      [{ text: "👤 حساب‌های متصل", callback_data: "account:list" }],
      [
        { text: "⚙️ تنظیمات", callback_data: "settings:open" },
        { text: "📊 آمار و عملکرد", callback_data: "stats:open" },
      ],
      [
        { text: "🔒 امنیت و نشست‌ها", callback_data: "security:open" },
        { text: "❌ قطع اتصال", callback_data: "account:disconnect" },
      ],
      [{ text: "❓ راهنما", callback_data: "help:open" }],
    ],
  };
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
      return { text: "🌸 پنل کنترل KageCatch\n\nیک بخش را انتخاب کن:", keyboard: buildMainMenu() };
    default:
      return { text: "این گزینه معتبر نیست. منوی اصلی را دوباره باز کن.", keyboard: BACK_MENU, alert: true };
  }
}

export function commandReply(text) {
  const command = (text || "").trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start" || command === "/panel") {
    return {
      text: "🌸 پنل کنترل KageCatch\n\nیک بخش را انتخاب کن:",
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

async function handleCallback(callback, env) {
  const chat = callback.message?.chat;
  if (chat?.type !== "private" || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(callback.from?.id)) {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "این بخش فقط در گفت‌وگوی خصوصی در دسترس است.", show_alert: true });
    return;
  }
  const result = resolveCallback(callback.data);
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
  if (message && message.chat?.type === "private" && Number.isSafeInteger(message.chat.id) && typeof message.text === "string") {
    const reply = commandReply(message.text);
    if (reply) {
      try {
        await telegramApi(env, "sendMessage", { chat_id: message.chat.id, ...reply });
      } catch {
        return new Response("Telegram delivery failed", { status: 502 });
      }
    }
  }
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return health(env);
    if (url.pathname === "/panel" && request.method === "GET") return panelPage();
    if (url.pathname === WEBHOOK_PATH) return handleWebhook(request, env);
    return json({ error: "not_found" }, 404);
  },
};
