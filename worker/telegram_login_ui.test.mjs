import test from "node:test";
import assert from "node:assert/strict";
import { buildLoginCodeKeyboard, maskLoginCode, parseLoginCodeCallback, validatePhoneNumber } from "./telegram_login_ui.mjs";

test("login keypad exposes only opaque actions, never a complete OTP", () => {
  const buttons = buildLoginCodeKeyboard().inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.callback_data === "auth:submit"));
  assert.ok(buttons.some((button) => button.callback_data === "auth:delete"));
  assert.ok(buttons.every((button) => !/\\d{4,}/.test(button.callback_data)));
});

test("login code is masked and bounded to Telegram OTP length", () => {
  assert.equal(maskLoginCode("12345"), "● ● ● ● ●");
  assert.throws(() => maskLoginCode("123456789"), TypeError);
});

test("phone numbers require international E.164 format", () => {
  assert.equal(validatePhoneNumber("+989121234567"), true);
  assert.equal(validatePhoneNumber("09121234567"), false);
  assert.equal(validatePhoneNumber("+012345678"), false);
});

test("login callback parser accepts only the declared actions", () => {
  assert.deepEqual(parseLoginCodeCallback("auth:digit:7"), { action: "digit", digit: "7" });
  assert.deepEqual(parseLoginCodeCallback("auth:submit"), { action: "submit" });
  assert.deepEqual(parseLoginCodeCallback("auth:delete"), { action: "delete" });
  assert.deepEqual(parseLoginCodeCallback("auth:cancel"), { action: "cancel" });
  assert.equal(parseLoginCodeCallback("auth:digit:12345"), null);
  assert.equal(parseLoginCodeCallback("auth:password:secret"), null);
});
