import test from "node:test";
import assert from "node:assert/strict";
import { buildLoginCodeKeyboard, maskLoginCode, parseLoginCodeCallback } from "./telegram_login_ui.mjs";

test("login code keyboard exposes digits, delete, and confirm without rendering the code", () => {
  const keyboard = buildLoginCodeKeyboard("12");
  const buttons = keyboard.inline_keyboard.flat();
  assert.deepEqual(buttons.slice(0, 3).map((button) => button.text), ["1", "2", "3"]);
  assert.equal(buttons.at(-1).text, "✅");
  assert.ok(buttons.every((button) => typeof button.callback_data === "string"));
  assert.ok(buttons.every((button) => button.callback_data.length <= 64));
  assert.equal(maskLoginCode("12"), "● ●");
  assert.ok(buttons.every((button) => !button.text.includes("12")));
});

test("login code callback parser accepts only bounded numeric input", () => {
  assert.deepEqual(parseLoginCodeCallback("auth:digit:12345"), { action: "submit", code: "12345" });
  assert.deepEqual(parseLoginCodeCallback("auth:delete:1234"), { action: "delete", code: "123" });
  assert.equal(parseLoginCodeCallback("auth:digit:12x"), null);
  assert.equal(parseLoginCodeCallback("auth:digit:" + "1".repeat(9)), null);
  assert.equal(parseLoginCodeCallback("auth:unknown:123"), null);
});

test("login code keyboard refuses malformed or oversized code state", () => {
  assert.throws(() => buildLoginCodeKeyboard("12x"), /Invalid login code/);
  assert.throws(() => buildLoginCodeKeyboard("1".repeat(9)), /Invalid login code/);
});
