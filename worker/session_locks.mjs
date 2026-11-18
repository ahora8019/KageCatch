const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const MAX_BODY_BYTES = 4096;
const MAX_LEASE_SECONDS = 900;
const MIN_LEASE_SECONDS = 30;

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

  // Durable Object nonce claim makes signed requests single-use across Worker isolates.
  const stub = env.CONNECT_LINKS.get(env.CONNECT_LINKS.idFromName("connection-links-v1"));
  const replay = await stub.fetch("https://connect-links.internal/claim-nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, expiresAt: Date.now() + 120_000 }),
  });
  return replay.status === 409 ? 409 : replay.ok ? 200 : 503;
}

function validLeaseSeconds(value) {
  return Number.isInteger(value) && value >= MIN_LEASE_SECONDS && value <= MAX_LEASE_SECONDS;
}

function validIdentity(body) {
  return typeof body?.session_id === "string"
    && body.session_id.length > 0
    && body.session_id.length <= 128
    && typeof body?.locked_by === "string"
    && /^[A-Za-z0-9_-]{16,128}$/.test(body.locked_by);
}

export async function handleSessionLocks(request, env) {
  const action = new URL(request.url).pathname.split("/").pop();
  if (!["acquire", "renew", "release"].includes(action)) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.KAGECATCH_DB || !env.CONNECT_LINKS) {
    return json({ error: "session_lock_store_unavailable" }, 503);
  }

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
  if (!validIdentity(body)) return json({ error: "invalid_lock_identity" }, 400);

  const { session_id: sessionId, locked_by: owner } = body;
  const db = env.KAGECATCH_DB;
  const now = Math.floor(Date.now() / 1000);

  try {
    if (action === "acquire") {
      if (!validLeaseSeconds(body.lease_seconds)) return json({ error: "invalid_lease" }, 400);
      const expiresAt = now + body.lease_seconds;
      const row = await db.prepare(
        `INSERT INTO session_locks
          (session_id, locked_by, expires_at, updated_at, fencing_token)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(session_id) DO UPDATE SET
          locked_by = excluded.locked_by,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at,
          fencing_token = session_locks.fencing_token + 1
         WHERE session_locks.expires_at <= ? OR session_locks.locked_by = ?
         RETURNING session_id, locked_by, expires_at, fencing_token`,
      ).bind(sessionId, owner, expiresAt, now, now, owner).first();

      return row
        ? json({ acquired: true, expires_at: row.expires_at, fencing_token: row.fencing_token })
        : json({ acquired: false }, 409);
    }

    if (!Number.isSafeInteger(body.fencing_token) || body.fencing_token < 1) {
      return json({ error: "invalid_fencing_token" }, 400);
    }

    if (action === "renew") {
      if (!validLeaseSeconds(body.lease_seconds)) return json({ error: "invalid_lease" }, 400);
      const expiresAt = now + body.lease_seconds;
      const row = await db.prepare(
        `UPDATE session_locks
         SET expires_at = ?, updated_at = ?
         WHERE session_id = ? AND locked_by = ? AND fencing_token = ? AND expires_at > ?
         RETURNING expires_at, fencing_token`,
      ).bind(expiresAt, now, sessionId, owner, body.fencing_token, now).first();

      return row
        ? json({ renewed: true, expires_at: row.expires_at, fencing_token: row.fencing_token })
        : json({ renewed: false }, 409);
    }

    // Retain the row as a fencing-token tombstone. Deleting it would reset the
    // next acquisition to token 1 and allow stale generations to collide.
    const result = await db.prepare(
      "UPDATE session_locks SET expires_at = ?, updated_at = ? WHERE session_id = ? AND locked_by = ? AND fencing_token = ?",
    ).bind(now, now, sessionId, owner, body.fencing_token).run();
    return json({ released: Number(result?.meta?.changes || 0) === 1 });
  } catch (error) {
    console.error(JSON.stringify({
      event: "session_lock_store_error",
      action,
      error: String(error?.message || error).slice(0, 200),
    }));
    return json({ error: "session_lock_store_unavailable" }, 503);
  }
}
