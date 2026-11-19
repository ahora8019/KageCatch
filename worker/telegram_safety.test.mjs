import test from "node:test";
import assert from "node:assert/strict";
import { classifyTelegramApiFailure } from "./telegram_safety.mjs";

test("Telegram 429 preserves retry_after as a bounded rate-limit instruction", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 429, parameters: { retry_after: 37 } }, 429),
    { kind: "rate_limited", retryAfterSeconds: 37, errorCode: 429 },
  );
});

test("Telegram 403 is permanent access restriction and is never classified as retryable", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 403 }, 403),
    { kind: "access_denied", retryAfterSeconds: null, errorCode: 403 },
  );
});

test("Telegram 401 is a credential failure, not a transient network error", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 401 }, 401),
    { kind: "invalid_credentials", retryAfterSeconds: null, errorCode: 401 },
  );
});

test("Telegram 5xx is transient but does not authorize an immediate retry", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 503 }, 503),
    { kind: "transient", retryAfterSeconds: null, errorCode: 503 },
  );
});

test("untrusted retry_after values are clamped and malformed values are ignored", () => {
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 429, parameters: { retry_after: 999999 } }, 429),
    { kind: "rate_limited", retryAfterSeconds: 86400, errorCode: 429 },
  );
  assert.deepEqual(
    classifyTelegramApiFailure({ ok: false, error_code: 429, parameters: { retry_after: "soon" } }, 429),
    { kind: "rate_limited", retryAfterSeconds: null, errorCode: 429 },
  );
});

test("error classification never copies Telegram descriptions into diagnostics", () => {
  const result = classifyTelegramApiFailure({
    ok: false,
    error_code: 400,
    description: "sensitive upstream detail",
  }, 400);
  assert.deepEqual(result, { kind: "invalid_request", retryAfterSeconds: null, errorCode: 400 });
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream detail/);
});
