import test from "node:test";
import assert from "node:assert/strict";
import { buildLoginCodeKeyboard, maskLoginCode, parseLoginCodeCallback, validatePhoneNumber } from "./telegram_login_ui.mjs";

test("keypad callback data contains actions only, never the typed code", () => {
  const keyboard = buildLoginCodeKeyboard();
  const buttons = keyboard.inline_keyboard.flat();
  assert.deepEqual(buttons.slice(0, 3).map((button) => button.text), ["1", "2", "3"]);
  assert.equal(buttons[9].text, "⌫");
  assert.equal(buttons[11].text, "✅");
  assert.ok(buttons.every((button) => !/\\d{4,}/.test(button.callback_data)));
  assert.ok(buttons.every((button) => button.callback_data.length <= 64));
  assert.equal(maskLoginCode("12345"), "● ● ● ● ●");
});

test("keypad callback parser accepts only fixed actions and digits", () => {
  assert.deepEqual(parseLoginCodeCallback("auth:digit:5"), { action: "digit", digit: "5" });
  assert.deepEqual(parseLoginCodeCallback("auth:delete"), { action: "delete" });
  assert.deepEqual(parseLoginCodeCallback("auth:submit"), { action: "submit" });
  assert.deepEqual(parseLoginCodeCallback("auth:cancel"), { action: "cancel" });
  assert.equal(parseLoginCodeCallback("auth:digit:55"), null);
  assert.equal(parseLoginCodeCallback("auth:submit:12345"), null);
  assert.equal(parseLoginCodeCallback("auth:unknown"), null);
});

test("phone validation accepts E.164 only", () => {
  assert.equal(validatePhoneNumber("+989121234567"), true);
  assert.equal(validatePhoneNumber("09121234567"), false);
  assert.equal(validatePhoneNumber("+0123"), false);
  assert.equal(validatePhoneNumber("+1abc"), false);
});
