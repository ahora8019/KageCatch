import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { enqueuePanelRequest, processPanelQueue, handlePanelCallback, parsePanelCallback } from "./panel_queue.mjs";

class FakeD1 {
  constructor() { this.rows = new Map(); }
  prepare(sql) {
    const db = this;
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async run() {
        const v = this.values;
        if (sql.startsWith("INSERT INTO panel_requests")) {
          const [request_id, idempotency_key, owner_id, chat_id, source_message_id] = v;
          if (![...db.rows.values()].some((r) => r.idempotency_key === idempotency_key)) {
            db.rows.set(request_id, { request_id, idempotency_key, owner_id, chat_id, source_message_id, status: "pending", attempts: 0, panel_message_id: null, expires_at: new Date(Date.now() + 600000).toISOString().replace("T", " ").slice(0, 19) });
          }
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE panel_requests SET status = 'completed'")) {
          const [panel_message_id, request_id] = v;
          const row = db.rows.get(request_id); if (row) Object.assign(row, { status: "completed", panel_message_id });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.startsWith("UPDATE panel_requests SET status = 'closed'")) {
          const [request_id] = v; const row = db.rows.get(request_id); if (row) row.status = "closed";
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.startsWith("UPDATE panel_requests SET status = ?, last_error_code")) {
          const [status, request_id] = v; const row = db.rows.get(request_id); if (row) row.status = status;
          return { meta: { changes: row ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
      async first() {
        const v = this.values;
        if (sql.includes("WHERE idempotency_key = ?")) return [...db.rows.values()].find((r) => r.idempotency_key === v[0]) || null;
        if (sql.includes("WHERE request_id = ?") && sql.startsWith("UPDATE")) {
          const row = db.rows.get(v[0]);
          if (!row || row.status !== "pending") return null;
          row.status = "processing"; row.attempts += 1; return { ...row };
        }
        if (sql.includes("WHERE request_id = ?")) return db.rows.get(v[0]) || null;
        return null;
      },
      async all() {
        return { results: [...db.rows.values()].filter((r) => r.status === "pending").map((r) => ({ request_id: r.request_id })) };
      },
    };
  }
}

function envWithDb() {
  const nonces = new Set();
  const db = new FakeD1();
  const stub = { async fetch(_url, init) {
    const { nonce } = JSON.parse(init.body);
    if (nonces.has(nonce)) return new Response("replay", { status: 409 });
    nonces.add(nonce); return new Response("ok", { status: 200 });
  }};
  return { KAGECATCH_DB: db, CORE_API_SECRET: "s".repeat(40), CONNECT_LINKS: { idFromName: () => "id", get: () => stub }, db };
}

function signedRequest(env, payload, nonce = "a".repeat(32)) {
  const path = "/internal/panel-requests";
  const body = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hash = createHash("sha256").update(body).digest("hex");
  const signingText = [timestamp, nonce, "POST", path, hash].join("\n");
  const signature = createHmac("sha256", env.CORE_API_SECRET).update(signingText).digest("hex");
  return new Request("https://worker.example" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "X-KageCatch-Timestamp": timestamp, "X-KageCatch-Nonce": nonce, "X-KageCatch-Signature": signature },
    body,
  });
}

test("signed group panel requests are accepted once and idempotent on source message identity", async () => {
  const env = envWithDb();
  const payload = { owner_id: "12345", chat_id: -100123456, source_message_id: 987 };
  const first = await enqueuePanelRequest(signedRequest(env, payload), env);
  assert.equal(first.status, 202);
  const firstData = await first.json();
  assert.equal(firstData.accepted, true);
  const second = await enqueuePanelRequest(signedRequest(env, payload, "b".repeat(32)), env);
  const secondData = await second.json();
  assert.equal(secondData.request_id, firstData.request_id);
  assert.equal(secondData.duplicate, true);
  assert.equal(env.db.rows.size, 1);
});

test("panel queue rejects invalid payload and invalid signature", async () => {
  const env = envWithDb();
  const invalid = await enqueuePanelRequest(signedRequest(env, { owner_id: "abc", chat_id: 5, source_message_id: 0 }), env);
  assert.equal(invalid.status, 400);
  const req = signedRequest(env, { owner_id: "12345", chat_id: -1001, source_message_id: 1 });
  const headers = new Headers(req.headers); headers.set("X-KageCatch-Signature", "0".repeat(64));
  const forged = new Request(req.url, { method: "POST", headers, body: await req.arrayBuffer() });
  assert.equal((await enqueuePanelRequest(forged, env)).status, 401);
});

test("scheduler claims a queued request once and stores the delivered panel message id", async () => {
  const env = envWithDb();
  const accepted = await enqueuePanelRequest(signedRequest(env, { owner_id: "12345", chat_id: -100123456, source_message_id: 987 }), env);
  const requestId = (await accepted.json()).request_id;
  const calls = [];
  const result = await processPanelQueue(env, async (method, payload) => {
    calls.push({ method, payload }); return { message_id: 444 };
  });
  assert.deepEqual(result, { processed: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].payload.chat_id, -100123456);
  assert.equal(env.db.rows.get(requestId).status, "completed");
  assert.equal(env.db.rows.get(requestId).panel_message_id, 444);
  assert.match(calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data, /^kp:[a-f0-9]{32}:stats$/);
});

test("panel callback is bound to owner, exact group and exact message", async () => {
  const env = envWithDb();
  const accepted = await enqueuePanelRequest(signedRequest(env, { owner_id: "12345", chat_id: -100123456, source_message_id: 987 }), env);
  const requestId = (await accepted.json()).request_id;
  const row = env.db.rows.get(requestId); Object.assign(row, { status: "completed", panel_message_id: 444 });
  const calls = [];
  const telegram = async (_env, method, payload) => calls.push({ method, payload });
  const callback = (from, chat, message) => ({
    id: "cb-1", from: { id: from }, message: { chat: { id: chat, type: "supergroup" }, message_id: message },
    data: "kp:" + requestId + ":engine",
  });
  assert.equal(await handlePanelCallback(callback(99999, -100123456, 444), env, telegram), true);
  assert.match(calls[0].payload.text, /دسترسی/);
  calls.length = 0;
  assert.equal(await handlePanelCallback(callback(12345, -100999, 444), env, telegram), true);
  assert.match(calls[0].payload.text, /دسترسی/);
  calls.length = 0;
  assert.equal(await handlePanelCallback(callback(12345, -100123456, 444), env, telegram), true);
  assert.match(calls.at(-1).payload.text, /ارسال زنده فرمان فعال نیست/);
});

test("panel callback payload is short, strict and rejects modified data", () => {
  assert.deepEqual(parsePanelCallback("kp:" + "a".repeat(32) + ":close"), { requestId: "a".repeat(32), action: "close" });
  assert.equal(parsePanelCallback("kp:" + "a".repeat(32) + ":owner"), null);
  assert.ok(Buffer.byteLength("kp:" + "a".repeat(32) + ":settings") <= 64);
});


test("simultaneous owners in separate groups receive independent panel queue records", async () => {
  const env = envWithDb();
  const payloads = [
    { owner_id: "12345", chat_id: -100123456, source_message_id: 1001 },
    { owner_id: "67890", chat_id: -100654321, source_message_id: 2002 },
  ];
  const [first, second] = await Promise.all(payloads.map((payload, index) =>
    enqueuePanelRequest(signedRequest(env, payload, String(index + 1).repeat(32)), env)
  ));
  const firstId = (await first.json()).request_id;
  const secondId = (await second.json()).request_id;
  assert.notEqual(firstId, secondId);
  const sent = [];
  const result = await processPanelQueue(env, async (_method, payload) => {
    sent.push(payload.chat_id);
    return { message_id: 5000 + sent.length };
  });
  assert.equal(result.processed, 2);
  assert.deepEqual(sent.sort((a, b) => a - b), [-100654321, -100123456]);
  assert.equal(env.db.rows.get(firstId).status, "completed");
  assert.equal(env.db.rows.get(secondId).status, "completed");
});

test("only the owner can close a panel and closed panels reject later callbacks", async () => {
  const env = envWithDb();
  const accepted = await enqueuePanelRequest(signedRequest(env, { owner_id: "12345", chat_id: -100123456, source_message_id: 987 }), env);
  const requestId = (await accepted.json()).request_id;
  Object.assign(env.db.rows.get(requestId), { status: "completed", panel_message_id: 444 });
  const calls = [];
  const telegram = async (_env, method, payload) => calls.push({ method, payload });
  const close = {
    id: "cb-close", from: { id: 12345 },
    message: { chat: { id: -100123456, type: "supergroup" }, message_id: 444 },
    data: "kp:" + requestId + ":close",
  };
  assert.equal(await handlePanelCallback(close, env, telegram), true);
  assert.equal(env.db.rows.get(requestId).status, "closed");
  calls.length = 0;
  const later = { ...close, id: "cb-after-close", data: "kp:" + requestId + ":stats" };
  await handlePanelCallback(later, env, telegram);
  assert.match(calls[0].payload.text, /دسترسی/);
});


test("panel delivery retries are bounded and eventually mark the request failed", async () => {
  const env = envWithDb();
  const accepted = await enqueuePanelRequest(signedRequest(env, { owner_id: "12345", chat_id: -100123456, source_message_id: 654 }), env);
  const requestId = (await accepted.json()).request_id;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await processPanelQueue(env, async () => { throw new Error("synthetic Telegram failure"); });
    assert.equal(env.db.rows.get(requestId).attempts, attempt);
    assert.equal(env.db.rows.get(requestId).status, attempt === 3 ? "failed" : "pending");
  }
});
