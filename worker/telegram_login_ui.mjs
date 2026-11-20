const MAX_LOGIN_CODE_LENGTH = 8;

export function maskLoginCode(code) {
  if (typeof code !== "string" || !/^\d{0,8}$/.test(code)) {
    throw new TypeError("Invalid login code");
  }
  return code ? Array.from(code, () => "●").join(" ") : "○ ○ ○ ○ ○";
}

export function buildLoginCodeKeyboard(code = "") {
  if (typeof code !== "string" || !/^\d{0,8}$/.test(code)) {
    throw new TypeError("Invalid login code");
  }
  const digitRows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]];
  const keyboard = digitRows.map((row) => row.map((digit) => ({
    text: digit,
    callback_data: "auth:digit:" + code + digit,
  })));
  keyboard.push([
    { text: "⌫", callback_data: "auth:delete:" + code },
    { text: "0", callback_data: "auth:digit:" + code + "0" },
    { text: "✅", callback_data: "auth:submit:" + code },
  ]);
  keyboard.push([{ text: "✖️ لغو ورود", callback_data: "auth:cancel" }]);
  return { inline_keyboard: keyboard };
}

export function parseLoginCodeCallback(data) {
  if (data === "auth:cancel") return { action: "cancel" };
  if (typeof data !== "string") return null;
  const match = data.match(/^auth:(digit|delete|submit):(\d{0,8})$/);
  if (!match) return null;
  const [, action, code] = match;
  if (action === "digit" && code.length === 0) return null;
  if (action === "delete" && code.length === 0) return { action, code: "" };
  return { action, code };
}

export const MAX_LOGIN_CODE_LENGTH_VALUE = MAX_LOGIN_CODE_LENGTH;
