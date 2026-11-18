import { reserveOutbound, updateTelegramBackoff, setOwnerSafetyLock } from "./telegram_safety.mjs";

const MAX_BODY_BYTES = 4096;
const OWNER_ID_PATTERN = /^[1-9]\d{0,19}$/;
const CHAT_ID_PATTERN = /^-?[1-9]\d{0,19}$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticate(request, env, rawBody) {
  if (!env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32 || !env.CONNECT_LINKS) return 503;
  const timestamp = request.headers.get("X-KageCatch-Timestamp") || "";
  const nonce = request.headers.get("X-KageCatch-Nonce") || "";
  const supplied = request.headers.get("X-KageCatch-Signature") || "";
  if (!/^\d{10,12}$/.test(timestamp)
      || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
      || !/^[a-f0-9]{64}$/.test(supplied)) return 401;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) return 401;

  const path = new URL(request.url).pathname;
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", rawBody));
  const canonical = [timestamp, nonce, request.method.toUpperCase(), path, bodyHash].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.CORE_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  if (difference !== 0) return 401;

  try {
    const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
    const replay = await stub.fetch("https://connect-links.internal/claim-nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, expiresAt: Date.now() + 120_000 }),
    });
    return replay.status === 409 ? 409 : replay.ok ? 200 : 503;
  } catch {
    return 503;
  }
}

function validOwnerId(value) {
  return typeof value === "string" && OWNER_ID_PATTERN.test(value);
}

function validChatId(value) {
  return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

function validNow(value) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

export async function handleTelegramSafetyApi(request, env) {
  const path = new URL(request.url).pathname;
  const action = path.slice("/internal/telegram-safety/".length);
  if (!["reserve", "backoff", "lock"].includes(action)) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let rawBody;
  try {
    rawBody = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (rawBody.byteLength > MAX_BODY_BYTES) return json({ error: "request_too_large" }, 413);

  const authStatus = await authenticate(request, env, rawBody);
  if (authStatus !== 200) {
    const error = authStatus === 409 ? "request_replayed"
      : authStatus === 503 ? "auth_unavailable" : "unauthorized";
    return json({ error }, authStatus);
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_request" }, 400);
  if (!env.KAGECATCH_DB?.prepare) return json({ error: "safety_store_unavailable" }, 503);
  if (!validOwnerId(body.ownerId) || !validNow(body.now)) return json({ error: "invalid_owner" }, 400);

  if (action === "reserve") {
    if (!validChatId(body.chatId)
        || (body.minimumIntervalSeconds !== undefined
          && (!Number.isInteger(body.minimumIntervalSeconds) || body.minimumIntervalSeconds < 0 || body.minimumIntervalSeconds > 60))) {
      return json({ error: "invalid_reservation" }, 400);
    }
    const result = await reserveOutbound(env, {
      ownerId: body.ownerId,
      chatId: body.chatId,
      ...(body.now === undefined ? {} : { now: body.now }),
      ...(body.minimumIntervalSeconds === undefined ? {} : { minimumIntervalSeconds: body.minimumIntervalSeconds }),
    });
    if (result.reason === "safety_store_unavailable") return json({ error: result.reason }, 503);
    return json(result);
  }

  if (action === "backoff") {
    if (!["flood_wait", "bot_retry_after"].includes(body.kind)
        || !Number.isSafeInteger(body.until) || body.until < 0) {
      return json({ error: "invalid_backoff" }, 400);
    }
    const result = await updateTelegramBackoff(env, {
      ownerId: body.ownerId,
      kind: body.kind,
      until: body.until,
      ...(body.now === undefined ? {} : { now: body.now }),
    });
    if (result.reason === "safety_store_unavailable") return json({ error: result.reason }, 503);
    if (result.reason === "owner_safety_state_missing") return json({ error: result.reason }, 404);
    if (!result.updated) return json({ error: result.reason || "backoff_update_failed" }, 400);
    return json(result);
  }

  if (typeof body.locked !== "boolean"
      || (body.reason !== undefined && body.reason !== null
        && (typeof body.reason !== "string" || body.reason.length > 160))) {
    return json({ error: "invalid_safety_state" }, 400);
  }
  const result = await setOwnerSafetyLock(env, {
    ownerId: body.ownerId,
    locked: body.locked,
    reason: body.reason ?? null,
    ...(body.now === undefined ? {} : { now: body.now }),
  });
  if (!result.updated) return json({ error: result.reason || "safety_store_unavailable" }, 503);
  return json(result);
}
