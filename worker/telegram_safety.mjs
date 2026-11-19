const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export function classifyTelegramApiFailure(payload, httpStatus = 0) {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const candidateCode = Number.isSafeInteger(body.error_code) ? body.error_code : httpStatus;
  const errorCode = Number.isSafeInteger(candidateCode) && candidateCode >= 100 && candidateCode <= 599
    ? candidateCode
    : null;

  let kind = "unknown";
  if (errorCode === 429) kind = "rate_limited";
  else if (errorCode === 401) kind = "invalid_credentials";
  else if (errorCode === 403) kind = "access_denied";
  else if (errorCode >= 400 && errorCode < 500) kind = "invalid_request";
  else if (errorCode >= 500 && errorCode < 600) kind = "transient";

  const rawRetryAfter = body.parameters?.retry_after;
  const retryAfterSeconds = kind === "rate_limited"
    && Number.isSafeInteger(rawRetryAfter)
    && rawRetryAfter >= 1
    ? Math.min(rawRetryAfter, MAX_RETRY_AFTER_SECONDS)
    : null;

  return { kind, retryAfterSeconds, errorCode };
}

export class TelegramApiError extends Error {
  constructor(payload, httpStatus = 0) {
    const policy = classifyTelegramApiFailure(payload, httpStatus);
    super("Telegram Bot API request failed (" + (policy.errorCode ?? "unknown") + ")");
    this.name = "TelegramApiError";
    this.kind = policy.kind;
    this.retryAfterSeconds = policy.retryAfterSeconds;
    this.errorCode = policy.errorCode;
  }
}
