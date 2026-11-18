import test from "node:test";
import assert from "node:assert/strict";
import { handleTelegramSafetyApi } from "./telegram_safety_api.mjs";

const SECRET = "s".repeat(40);

function makeNonceBinding() {
  const used = new Set();
  return {
    used,
    idFromName: () => "connection-links-v1",
    get: () => ({
      fetch: async (_url, init) => {
        const { nonce } = JSON.parse(init.body);
        if (used.has(nonce)) return new Response("replay", { status: 409 });
        used.add(nonce);
        return new Response("ok", { status: 200 });
      },
    }),
  };
}

async function signedRequest(path, payload, env, options = {}) {
  const method = options.method || "POST";
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce || crypto.randomUUID().replaceAll("-", "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const bodyHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const canonical = [timestamp, nonce, method, path, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://worker.example" + path, {
    method,
    headers: {
      "content-type": "application/json",
      "X-KageCatch-Timestamp": options.timestamp || timestamp,
      "X-KageCatch-Nonce": nonce,
      "X-KageCatch-Signature": options.signature || signature,
    },
    body: body || undefined,
  });
}

function makeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind(...values) {
        return {
          first: async () => {
            calls.push({ sql, values });
            if (sql.includes("INSERT INTO telegram_send_pacing")) return { next_allowed_at: values[2] };
            if (sql.includes("INSERT INTO telegram_safety_state")) return {
              owner_id: values[0], security_locked: values[1], lock_reason: values[2],
            };
            return null;
          },
          run: async () => {
            calls.push({ sql, values });
            return { meta: { changes: 1 } };
          },
        };
      } };
    },
  };
}

function makeEnv(overrides = {}) {
  return { CORE_API_SECRET: SECRET, CONNECT_LINKS: makeNonceBinding(), KAGECATCH_DB: makeDb(), ...overrides };
}

test("Telegram safety API rejects unsigned requests and unsupported methods", async () => {
  const env = makeEnv();
  const unsigned = await handleTelegramSafetyApi(new Request("https://worker.example/internal/telegram-safety/reserve", { method: "POST" }), env);
  assert.equal(unsigned.status, 401);
  const method = await handleTelegramSafetyApi(new Request("https://worker.example/internal/telegram-safety/reserve", { method: "GET" }), env);
  assert.equal(method.status, 405);
});

test("Telegram safety API rejects replayed signed requests", async () => {
  const env = makeEnv();
  const path = "/internal/telegram-safety/reserve";
  const request = await signedRequest(path, { ownerId: "12345", chatId: "67890" }, env, { nonce: "replay-nonce-0001" });
  assert.equal((await handleTelegramSafetyApi(request, env)).status, 200);
  const replay = await signedRequest(path, { ownerId: "12345", chatId: "67890" }, env, { nonce: "replay-nonce-0001" });
  const response = await handleTelegramSafetyApi(replay, env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "request_replayed" });
});

test("reserve endpoint validates owner and chat identifiers before touching D1", async () => {
  const env = makeEnv();
  const path = "/internal/telegram-safety/reserve";
  const request = await signedRequest(path, { ownerId: "../owner", chatId: "67890" }, env);
  const response = await handleTelegramSafetyApi(request, env);
  assert.equal(response.status, 400);
  assert.equal(env.KAGECATCH_DB.calls.length, 0);
});

test("reserve endpoint returns the shared pacing reservation result", async () => {
  const env = makeEnv();
  const path = "/internal/telegram-safety/reserve";
  const request = await signedRequest(path, { ownerId: "12345", chatId: "-10067890", minimumIntervalSeconds: 2 }, env);
  const response = await handleTelegramSafetyApi(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { allowed: true, nextAllowedAt: env.KAGECATCH_DB.calls[0].values[2] });
});

test("backoff endpoint only accepts known backoff kinds and reports missing owners", async () => {
  const env = makeEnv();
  const path = "/internal/telegram-safety/backoff";
  const request = await signedRequest(path, { ownerId: "12345", kind: "arbitrary_sql", until: 200 }, env);
  const response = await handleTelegramSafetyApi(request, env);
  assert.equal(response.status, 400);
  assert.equal(env.KAGECATCH_DB.calls.length, 0);
});

test("lock endpoint updates only the security lock fields", async () => {
  const env = makeEnv();
  const path = "/internal/telegram-safety/lock";
  const request = await signedRequest(path, { ownerId: "12345", locked: true, reason: "manual_review" }, env);
  const response = await handleTelegramSafetyApi(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { updated: true, locked: true, reason: "manual_review" });
  assert.match(env.KAGECATCH_DB.calls[0].sql, /ON CONFLICT\(owner_id\) DO UPDATE SET[\s\S]*security_locked = excluded.security_locked/i);
  assert.doesNotMatch(env.KAGECATCH_DB.calls[0].sql.split("ON CONFLICT")[1], /session_revoked\s*=/i);
});

test("Telegram safety API fails closed when shared D1 is unavailable", async () => {
  const env = makeEnv({ KAGECATCH_DB: undefined });
  const path = "/internal/telegram-safety/reserve";
  const request = await signedRequest(path, { ownerId: "12345", chatId: "67890" }, env);
  const response = await handleTelegramSafetyApi(request, env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "safety_store_unavailable" });
});
