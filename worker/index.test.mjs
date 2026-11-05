import test from "node:test";
import assert from "node:assert/strict";
import { buildMainMenu, resolveCallback, commandReply } from "./index.mjs";

test("main menu is inline-first and exposes the agreed account controls", () => {
  const menu = buildMainMenu();
  const callbacks = menu.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(callbacks, [
    "account:connect",
    "account:list",
    "settings:open",
    "stats:open",
    "security:open",
    "account:disconnect",
    "help:open",
  ]);
  assert.equal(menu.inline_keyboard.flat().some((button) => button.url), false);
});

test("connect callback never asks for a phone, login code, or 2FA password", () => {
  const result = resolveCallback("account:connect");
  assert.match(result.text, /اتصال امن هنوز فعال نشده/);
  assert.match(result.text, /کد ورود یا رمز دومرحله‌ای را اینجا ارسال نکن/);
  assert.doesNotMatch(result.text, /شماره تلفن خود را وارد کن|کد ورود را بفرست|رمز دومرحله‌ای را وارد کن/);
});

test("account and security callbacks disclose only current unavailable state", () => {
  assert.match(resolveCallback("account:list").text, /هسته اجرایی هنوز متصل نیست/);
  assert.match(resolveCallback("security:open").text, /هیچ کد ورود یا رمز دومرحله‌ای در بات دریافت نمی‌شود/);
  assert.match(resolveCallback("account:disconnect").text, /حساب متصلی ثبت نشده/);
});

test("unknown callback is rejected safely", () => {
  assert.equal(resolveCallback("account:unknown").alert, true);
});

test("start and panel commands return the inline menu", () => {
  const start = commandReply("/start");
  const panel = commandReply("/panel");
  assert.equal(start.reply_markup.inline_keyboard.length, 5);
  assert.deepEqual(panel.reply_markup, start.reply_markup);
});

test("status and help remain available as slash-command shortcuts", () => {
  assert.match(commandReply("/status").text, /Python Core: متصل نیست/);
  assert.match(commandReply("/help").text, /دکمه‌های منوی اصلی/);
});
