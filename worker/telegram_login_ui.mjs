export function maskLoginCode(code) {
  if (typeof code !== "string" || !/^[0-9]{0,8}$/.test(code)) throw new TypeError("Invalid login code");
  return code ? Array.from(code, () => "●").join(" ") : "○ ○ ○ ○ ○";
}

export function validatePhoneNumber(phone) {
  return typeof phone === "string" && /^\+[1-9][0-9]{7,14}$/.test(phone.trim());
}

export function buildLoginCodeKeyboard() {
  const rows = [[ "1", "2", "3" ], [ "4", "5", "6" ], [ "7", "8", "9" ]]
    .map((row) => row.map((digit) => ({ text: digit, callback_data: "auth:digit:" + digit })));
  rows.push([
    { text: "⌫", callback_data: "auth:delete" },
    { text: "0", callback_data: "auth:digit:0" },
    { text: "✅", callback_data: "auth:submit" },
  ]);
  rows.push([{ text: "✖️ لغو ورود", callback_data: "auth:cancel" }]);
  return { inline_keyboard: rows };
}

export function parseLoginCodeCallback(data) {
  if (data === "auth:delete") return { action: "delete" };
  if (data === "auth:submit") return { action: "submit" };
  if (data === "auth:cancel") return { action: "cancel" };
  const match = typeof data === "string" ? data.match(/^auth:digit:([0-9])$/) : null;
  return match ? { action: "digit", digit: match[1] } : null;
}
