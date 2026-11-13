const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function authenticate(request, env, rawBody) {
  if (!env.CORE_API_SECRET || String(env.CORE_API_SECRET).length < 32 || !env.CONNECT_LINKS) return 503;
  const timestamp = request.headers.get("X-KageCatch-Timestamp") || "";
  const nonce = request.headers.get("X-KageCatch-Nonce") || "";
  const supplied = request.headers.get("X-KageCatch-Signature") || "";
  if (!/^\d{10,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) return 401;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) return 401;
  const path = new URL(request.url).pathname;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)), b => b.toString(16).padStart(2, "0")).join("");
  const message = [timestamp, nonce, request.method, path, hash].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CORE_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))), b => b.toString(16).padStart(2, "0")).join("");
  let diff = sig.length ^ supplied.length;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ supplied.charCodeAt(i);
  if (diff) return 401;
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const replay = await stub.fetch("https://connect-links.internal/claim-nonce", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, expiresAt: Date.now() + 120000 }),
  });
  return replay.status === 409 ? 409 : replay.ok ? 200 : 503;
}

export async function handleSessionLocks(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.KAGECATCH_DB || !env.CONNECT_LINKS) return json({ error: "session_lock_store_unavailable" }, 503);
  let raw;
  try { raw = new Uint8Array(await request.arrayBuffer()); } catch { return json({ error: "invalid_request" }, 400); }
  if (raw.byteLength > 4096) return json({ error: "request_too_large" }, 413);
  const auth = await authenticate(request, env, raw);
  if (auth !== 200) return json({ error: auth === 503 ? "auth_unavailable" : auth === 409 ? "request_replayed" : "unauthorized" }, auth);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: "invalid_request" }, 400); }
  const action = new URL(request.url).pathname.split("/").pop();
  const sessionId = body?.session_id;
  const owner = body?.locked_by;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128
      || typeof owner !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(owner)) return json({ error: "invalid_lock_identity" }, 400);
  const db = env.KAGECATCH_DB;
  const now = Math.floor(Date.now() / 1000);
  try {
    if (action === "acquire") {
      if (!Number.isInteger(body.lease_seconds) || body.lease_seconds < 30 || body.lease_seconds > 900) return json({ error: "invalid_lease" }, 400);
      const expires = now + body.lease_seconds;
      const row = await db.prepare(
        "INSERT INTO session_locks (session_id, locked_by, expires_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET locked_by=excluded.locked_by, expires_at=excluded.expires_at, updated_at=excluded.updated_at WHERE session_locks.expires_at <= ? OR session_locks.locked_by = ? RETURNING session_id, locked_by, expires_at"
      ).bind(sessionId, owner, expires, now, now, owner).first();
      return row ? json({ acquired: true, expires_at: row.expires_at }) : json({ acquired: false }, 409);
    }
    if (action === "renew") {
      if (!Number.isInteger(body.lease_seconds) || body.lease_seconds < 30 || body.lease_seconds > 900) return json({ error: "invalid_lease" }, 400);
      const expires = now + body.lease_seconds;
      const row = await db.prepare(
        "UPDATE session_locks SET expires_at = ?, updated_at = ? WHERE session_id = ? AND locked_by = ? AND expires_at > ? RETURNING expires_at"
      ).bind(expires, now, sessionId, owner, now).first();
      return row ? json({ renewed: true, expires_at: row.expires_at }) : json({ renewed: false }, 409);
    }
    if (action === "release") {
      const result = await db.prepare("DELETE FROM session_locks WHERE session_id = ? AND locked_by = ?").bind(sessionId, owner).run();
      return json({ released: Number(result?.meta?.changes || 0) === 1 });
    }
    return json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "session_lock_store_unavailable" }, 503);
  }
}
