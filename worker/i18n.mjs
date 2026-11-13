const MESSAGES = {
  fa: {
    "menu.overview": "📊 نمای کلی", "menu.catcher": "🎯 شکارچی",
    "menu.settings": "⚙️ تنظیمات", "menu.account": "👤 حساب",
    "settings.title": "⚙️ <b>تنظیمات</b>",
    "settings.description": "تنظیمات حساب و تجربهٔ کاربری از این بخش مدیریت می‌شوند.",
    "settings.language": "🌐 زبان", "settings.security": "🔒 امنیت", "settings.help": "❓ راهنما",
    "language.title": "🌐 <b>زبان برنامه</b>",
    "language.description": "زبان نمایش منوها و پیام‌های KageCatch را انتخاب کن.",
    "language.persian": "🇮🇷 فارسی", "language.english": "🇬🇧 انگلیسی",
    "language.selected.fa": "زبان برنامه روی فارسی تنظیم شد.",
    "language.selected.en": "زبان برنامه روی انگلیسی تنظیم شد.",
    "dashboard.title": "🌸 <b>KAGECATCH | داشبورد</b>",
    "dashboard.user": "👤 کاربر",
    "dashboard.control": "🟢 هستهٔ کنترل",
    "dashboard.core": "⚙️ هستهٔ پایتون",
    "dashboard.session": "🔐 نشست",
    "dashboard.catch": "🎯 وضعیت شکار",
    "dashboard.select": "یک گزینه را انتخاب کن:",
    "status.online": "آنلاین", "status.degraded": "مختل", "status.unavailable": "در دسترس نیست",
    "status.not_configured": "پیکربندی نشده", "status.not_checked": "بررسی نشده",
    "status.connected": "متصل", "status.authorized": "مجاز", "status.not_connected": "متصل نیست",
    "status.unknown": "نامشخص", "status.enabled": "فعال", "status.disabled": "غیرفعال",
    "status.ready": "آماده", "status.not_ready": "آماده نیست",
    "catcher.title": "🎯 <b>KAGECATCH | شکارچی</b>",
    "catcher.account": "🔐 حساب", "catcher.mode": "🎯 وضعیت شکار", "catcher.execution": "⚙️ اجرا",
    "catcher.ready": "مسیر اجرا آماده است؛ شروع شکار همچنان تحت کنترل صریح توست.",
    "catcher.not_ready": "اجرای زنده هنوز آماده نیست. هیچ عملیات شکاری آغاز نشد.",
    "navigation.back": "⬅️ منوی اصلی"
  },
  en: {
    "menu.overview": "📊 Overview", "menu.catcher": "🎯 Catcher",
    "menu.settings": "⚙️ Settings", "menu.account": "👤 Account",
    "settings.title": "⚙️ <b>SETTINGS</b>",
    "settings.description": "Manage your account and app preferences here.",
    "settings.language": "🌐 Language", "settings.security": "🔒 Security", "settings.help": "❓ Help",
    "language.title": "🌐 <b>App language</b>",
    "language.description": "Choose the language used by KageCatch menus and messages.",
    "language.persian": "🇮🇷 Persian", "language.english": "🇬🇧 English",
    "language.selected.fa": "App language has been set to Persian.",
    "language.selected.en": "App language has been set to English.",
    "dashboard.title": "🌸 <b>KAGECATCH | DASHBOARD</b>",
    "dashboard.user": "👤 User",
    "dashboard.control": "🟢 Control Plane",
    "dashboard.core": "⚙️ Python Core",
    "dashboard.session": "🔐 Session",
    "dashboard.catch": "🎯 Catch Mode",
    "dashboard.select": "Select an option:",
    "status.online": "Online", "status.degraded": "Degraded", "status.unavailable": "Unavailable",
    "status.not_configured": "Not configured", "status.not_checked": "Not checked",
    "status.connected": "Connected", "status.authorized": "Authorized", "status.not_connected": "Not connected",
    "status.unknown": "Unknown", "status.enabled": "Enabled", "status.disabled": "Disabled",
    "status.ready": "Ready", "status.not_ready": "Not ready",
    "catcher.title": "🎯 <b>KAGECATCH | CATCHER</b>",
    "catcher.account": "🔐 Account", "catcher.mode": "🎯 Catch Mode", "catcher.execution": "⚙️ Execution",
    "catcher.ready": "Execution pipeline is ready. Catch remains under your explicit control.",
    "catcher.not_ready": "Live execution is not ready. No catch action was started.",
    "navigation.back": "⬅️ Main menu"
  }
};

export function normalizeLanguage(value) {
  return value === "en" ? "en" : "fa";
}

export function translate(key, language = "fa") {
  const locale = normalizeLanguage(language);
  return MESSAGES[locale][key] ?? MESSAGES.fa[key] ?? key;
}

export function languageKeyboard(language = "fa") {
  const locale = normalizeLanguage(language);
  return {
    inline_keyboard: [
      [{ text: (locale === "fa" ? "✓ " : "") + translate("language.persian", locale), callback_data: "language:set:fa" }],
      [{ text: (locale === "en" ? "✓ " : "") + translate("language.english", locale), callback_data: "language:set:en" }],
      [{ text: translate("navigation.back", locale), callback_data: "settings:open" }]
    ]
  };
}
