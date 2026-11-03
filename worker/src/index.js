const WEBHOOK_PATH = "/webhook";
const MAX_BODY_BYTES = 256 * 1024;
const VERSION = "0.2.1";

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
      python_core: env.PYTHON_CORE_URL && env.BRIDGE_SHARED_SECRET ? "configured_not_verified" : "not_connected",
      version: VERSION,
    });
  } catch {
    return json({ service: "KageCatch Control", status: "degraded", webhook_auth: "enabled", version: VERSION }, 503);
  }
}

function panelPage() {
  return new Response(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
</style></head>
<body><main>
<div class="brand">KAGECATCH / CONTROL PLANE</div><h1>پنل کنترل KageCatch</h1>
<p class="sub">وضعیت سرویس کنترل تلگرام و هستهٔ اجرایی</p>
<section class="grid">
<div class="card"><div class="label">وضعیت Worker</div><div class="value" id="worker"><span class="status"></span>در حال بررسی…</div></div>
<div class="card"><div class="label">اتصال Webhook</div><div class="value" id="webhook">در حال بررسی…</div></div>
<div class="card"><div class="label">بات تلگرام</div><div class="value" id="bot">در حال بررسی…</div></div>
<div class="card"><div class="label">Python Core</div><div class="value" id="core">هنوز متصل نیست</div></div>
</section>
<div class="note">این پنل فعلاً وضعیت Control Plane را نمایش می‌دهد. اجرای Catch، مدیریت Sessionها و کنترل پایدار کاربران تا اتصال Python Core و لایهٔ ذخیره‌سازی فعال نیست.</div>
<footer>KageCatch · Worker v${VERSION} · اطلاعات بدون افشای پیام‌ها یا اطلاعات کاربران</footer>
</main>
<script>
fetch('/health',{cache:'no-store'}).then(r=>r.json()).then(s=>{
document.querySelector('#worker').textContent=s.status||'نامشخص';
document.querySelector('#webhook').textContent=s.telegram_webhook||'نامشخص';
document.querySelector('#bot').textContent=s.bot?.username?'@'+s.bot.username:'نامشخص';
document.querySelector('#core').textContent=s.python_core==='connected'?'متصل':'هنوز متصل نیست';
}).catch(()=>{document.querySelector('#worker').textContent='عدم دسترسی';});
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}

function commandReply(text) {
  const command = (text || "").trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start") {
    return "🌸 به KageCatch خوش اومدی!\nاینجا قراره کچ و پیک کاراکترها راحت‌تر بشه.\nاز بخش کچ و پیک می‌تونی بات‌های موردنظرت رو بشناسی و وضعیت قابلیت‌ها رو ببینی.\nبرای راهنما /help رو بزن.";
  }
  if (command === "/panel") {
    return "🎯 پنل KageCatch\n\n🎬 SenpaiCatcherBot — کچ ویدئویی با دستور /pick {name}\n🖼 HentaCatcherBot — کچ تصویری با دستور /catch {name}\n🖼 Character_Catcher_Bot — کچ تصویری با دستور /catch {name}\n\n⏳ اتصال و اجرای خودکار کچ در KageCatch هنوز فعال نشده؛ فعلاً این بخش فقط معرفی بات‌هاست.";
  }
  if (command === "/status") {
    return "📊 وضعیت KageCatch\n\n🌸 بخش معرفی بات‌های کچ: فعال\n🎯 مدیریت و اجرای خودکار Catch: هنوز آماده نیست\n📥 دریافت درخواست و صف کچ: هنوز فعال نشده\n\nبه محض آماده شدن قابلیت‌ها، وضعیت همین‌جا به‌روزرسانی می‌شه.";
  }
  if (command === "/help") {
    return "📖 راهنمای KageCatch\n\n/start — شروع کار\n/panel — معرفی بات‌های کچ\n/status — وضعیت قابلیت‌ها\n/help — نمایش این راهنما\n\nدستورهای بات‌های هدف:\n🎬 SenpaiCatcherBot: /pick {name}\n🖼 HentaCatcherBot: /catch {name}\n🖼 Character_Catcher_Bot: /catch {name}\n\n⚠️ این دستورها متعلق به بات‌های هدف هستند؛ اجرای مستقیم کچ از داخل KageCatch هنوز فعال نشده.";
  }
  return null;
}


function inlinePanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🏠 پنل اصلی", callback_data: "kc:home" }],
      [
        { text: "🤖 بات‌ها", callback_data: "kc:bots" },
        { text: "📊 وضعیت", callback_data: "kc:status" },
      ],
      [
        { text: "⚙️ تنظیمات", callback_data: "kc:settings" },
        { text: "🛑 توقف اضطراری", callback_data: "kc:stop" },
      ],
    ],
  };
}

function panelView(action) {
  const views = {
    "kc:home": {
      text: "🌸 پنل کنترل KageCatch\\n\\nAuto Catch: خاموش 🔴\\nاجرای Catch تا تکمیل اتصال و تأیید نهایی غیرفعال است.\\n\\nاز دکمه‌های زیر برای مشاهده بخش‌ها استفاده کن.",
    },
    "kc:bots": {
      text: "🤖 مدیریت بات‌ها\\n\\n🎬 SenpaiCatcherBot — وضعیت اتصال: بررسی‌نشده\\n🖼 HentaCatcherBot — وضعیت اتصال: بررسی‌نشده\\n🖼 Character_Catcher_Bot — وضعیت اتصال: بررسی‌نشده\\n\\nانتخاب و روشن‌کردن بات‌ها پس از اتصال امن Python Core فعال می‌شود. هیچ Catchی اجرا نمی‌شود.",
    },
    "kc:status": {
      text: "📊 وضعیت KageCatch\\n\\n🟢 Telegram Worker: پاسخ‌گو\\n🔴 Python Core: هنوز متصل/تأیید نشده\\n🔴 Auto Catch: خاموش\\n⏸ صف Catch: فعال نیست\\n\\nاین وضعیت از اجرای واقعی Catch خبر نمی‌دهد.",
    },
    "kc:settings": {
      text: "⚙️ تنظیمات\\n\\nتنظیمات حساب، سهمیه و Listener هنوز به ذخیره‌سازی پایدار متصل نشده‌اند.\\nتا آن زمان این گزینه‌ها فقط نمایشی هستند و تغییری در حساب ایجاد نمی‌کنند.",
    },
    "kc:stop": {
      text: "🛑 توقف اضطراری\\n\\nAuto Catch در حال حاضر از ابتدا غیرفعال است و هیچ Catch فعالی از KageCatch اجرا نمی‌شود.\\nوضعیت امن حفظ شد؛ این دکمه هیچ درخواست Catch ارسال نمی‌کند.",
    },
  };
  return views[action] || null;
}

async function handleCallbackQuery(update, env) {
  const query = update?.callback_query;
  const callbackId = query?.id;
  const sender = query?.from;
  const message = query?.message;
  const chat = message?.chat;
  const messageId = message?.message_id;
  if (typeof callbackId !== "string" || !callbackId ||
      !Number.isSafeInteger(sender?.id) || sender.id <= 0 ||
      sender.is_bot === true || !Number.isSafeInteger(chat?.id) ||
      !Number.isSafeInteger(messageId) || messageId <= 0) {
    return new Response("OK", { status: 200 });
  }

  const ownsPrivateChat = chat.type === "private" && sender.id === chat.id;
  if (!ownsPrivateChat) {
    try {
      await telegramApi(env, "answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "این پنل فقط از اکانت صاحب همان گفت‌وگوی خصوصی قابل کنترل است.",
        show_alert: true,
      });
    } catch {
      return new Response("Telegram callback acknowledgement failed", { status: 502 });
    }
    return new Response("OK", { status: 200 });
  }

  const view = panelView(query.data);
  if (!view) {
    try {
      await telegramApi(env, "answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "این گزینه معتبر یا فعال نیست.",
        show_alert: true,
      });
    } catch {
      return new Response("Telegram callback acknowledgement failed", { status: 502 });
    }
    return new Response("OK", { status: 200 });
  }

  const answerText = query.data === "kc:stop"
    ? "Auto Catch از قبل خاموش است؛ وضعیت امن حفظ شد."
    : "انجام شد.";
  try {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: answerText,
    });
    await telegramApi(env, "editMessageText", {
      chat_id: chat.id,
      message_id: messageId,
      text: view.text,
      reply_markup: inlinePanelKeyboard(),
    });
  } catch {
    return new Response("Telegram panel update failed", { status: 502 });
  }
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function extractBridgeCommand(update) {
  const message = update?.message;
  const sender = message?.from;
  const chat = message?.chat;
  if (!message || !sender || !chat || sender.is_bot === true) return null;
  if (!Number.isSafeInteger(sender.id) || sender.id <= 0) return null;
  if (!Number.isSafeInteger(chat.id) || chat.id !== sender.id || chat.type !== "private") return null;
  if (message.text !== "/connect" && message.text !== "/cancel") return null;
  return {
    update_id: update.update_id,
    message: {
      from: { id: sender.id },
      chat: { id: chat.id, type: "private" },
      text: message.text,
    },
  };
}

async function signBridgeRequest(secret, method, path, timestamp, nonce, body) {
  const encoder = new TextEncoder();
  const bodyHash = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  const hashHex = Array.from(new Uint8Array(bodyHash), byte => byte.toString(16).padStart(2, "0")).join("");
  const canonical = ["v1", method.toUpperCase(), path, timestamp, nonce, hashHex].join("\n");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function forwardToPythonCore(env, sanitizedUpdate) {
  if (!env.PYTHON_CORE_URL || !env.BRIDGE_SHARED_SECRET || env.BRIDGE_SHARED_SECRET.length < 32) {
    throw new Error("Python Core bridge is not configured");
  }
  const base = new URL(env.PYTHON_CORE_URL);
  if (base.protocol !== "https:" || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Python Core URL must be an HTTPS origin");
  }
  const path = "/internal/telegram-update";
  const target = new URL(path, base).toString();
  const body = JSON.stringify(sanitizedUpdate);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const signature = await signBridgeRequest(
    env.BRIDGE_SHARED_SECRET, "POST", path, timestamp, nonce, body,
  );
  const requestFetch = env.FETCH || fetch;
  const response = await requestFetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-KageCatch-Timestamp": timestamp,
      "X-KageCatch-Nonce": nonce,
      "X-KageCatch-Signature": signature,
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Python Core bridge rejected the request");
  const result = await response.json();
  if (!result || result.ok !== true || typeof result.handled !== "boolean") {
    throw new Error("Python Core bridge returned an invalid response");
  }
  if (result.reply !== undefined) {
    if (!result.reply || result.reply.chat_id !== sanitizedUpdate.message.chat.id ||
        typeof result.reply.text !== "string" || result.reply.text.length < 1 ||
        result.reply.text.length > 4096) {
      throw new Error("Python Core bridge returned an invalid reply");
    }
  }
  return result;
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
  const bridgedUpdate = extractBridgeCommand(update);
  if (bridgedUpdate) {
    try {
      if (env.PYTHON_CORE_URL || env.BRIDGE_SHARED_SECRET) {
        const result = await forwardToPythonCore(env, bridgedUpdate);
        if (result.reply) {
          await telegramApi(env, "sendMessage", {
            chat_id: result.reply.chat_id,
            text: result.reply.text,
          });
        }
      } else {
        const text = bridgedUpdate.message.text === "/connect"
          ? "اتصال حساب فعلاً فعال نیست؛ مسیر امن Python Core هنوز پیکربندی نشده است."
          : "مدیریت درخواست اتصال فعلاً در دسترس نیست.";
        await telegramApi(env, "sendMessage", {
          chat_id: bridgedUpdate.message.chat.id,
          text,
        });
      }
    } catch {
      return new Response("Python Core bridge or Telegram delivery failed", { status: 502 });
    }
    return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (update.callback_query) return handleCallbackQuery(update, env);

  const message = update.message;
  if (message && Number.isSafeInteger(message.chat?.id) && typeof message.text === "string") {
    const reply = commandReply(message.text);
    if (reply) {
      try {
        const payload = { chat_id: message.chat.id, text: reply };
        const command = message.text.trim().split(/\\s+/, 1)[0].split("@", 1)[0].toLowerCase();
        if (command === "/panel") payload.reply_markup = inlinePanelKeyboard();
        await telegramApi(env, "sendMessage", payload);
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
