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
