import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.mjs";

const secret = "kagecatch-test-secret-with-more-than-thirty-two-bytes";

async function signedRequest(path, payload, nonce = crypto.randomUUID().replaceAll("-", "")) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const canonical = [timestamp, nonce, "POST", path, bodyHash].join("\n");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Request("https://worker.example" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-KageCatch-Timestamp": timestamp,
      "X-KageCatch-Nonce": nonce,
      "X-KageCatch-Signature": signature,
    },
    body,
  });
}

function makeEnv() {
  const usedNonces = new Set();
  const statements = [];
  const lockRows = new Map();
  const db = {
    statements,
    lockRows,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              statements.push({ sql, values });
              if (sql.includes("INSERT INTO session_locks")) {
                const [sessionId, owner, expiresAt, now, conflictNow, sameOwner] = values;
                const existing = lockRows.get(sessionId);
                if (!existing) {
                  const row = { session_id: sessionId, locked_by: owner, expires_at: expiresAt, fencing_token: 1 };
                  lockRows.set(sessionId, row);
                  return { ...row };
                }
                if (existing.expires_at <= conflictNow || existing.locked_by === sameOwner) {
                  const row = {
                    session_id: sessionId,
                    locked_by: owner,
                    expires_at: expiresAt,
                    fencing_token: existing.fencing_token + 1,
                  };
                  lockRows.set(sessionId, row);
                  return { ...row };
                }
                return null;
              }
              if (sql.includes("UPDATE session_locks") && sql.includes("RETURNING expires_at")) {
                const [expiresAt, now, sessionId, owner, token, leaseNow] = values;
                const existing = lockRows.get(sessionId);
                if (!existing || existing.locked_by !== owner
                  || existing.fencing_token !== token || existing.expires_at <= leaseNow) return null;
                existing.expires_at = expiresAt;
                return { expires_at: expiresAt, fencing_token: existing.fencing_token };
              }
              return null;
            },
            async run() {
              statements.push({ sql, values });
              if (sql.startsWith("UPDATE session_locks SET expires_at = ?")) {
                const [expiresAt, now, sessionId, owner, token] = values;
                const existing = lockRows.get(sessionId);
                if (!existing || existing.locked_by !== owner || existing.fencing_token !== token) {
                  return { meta: { changes: 0 } };
                }
                existing.expires_at = expiresAt;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const durableObject = {
    async fetch(_url, init) {
      const nonce = JSON.parse(init.body).nonce;
      if (usedNonces.has(nonce)) return new Response("replay", { status: 409 });
      usedNonces.add(nonce);
      return new Response("ok", { status: 200 });
    },
  };
  return {
    db,
    env: {
      CORE_API_SECRET: secret,
      KAGECATCH_DB: db,
      CONNECT_LINKS: {
        idFromName: () => "connection-links-v1",
        get: () => durableObject,
      },
    },
  };
}

test("session lock routes reject requests without valid HMAC authentication", async () => {
  const { env } = makeEnv();
  const response = await worker.fetch(new Request(
    "https://worker.example/internal/session-locks/acquire",
    { method: "POST", body: "{}" },
  ), env);
  assert.equal(response.status, 401);
});

test("acquire uses atomic upsert and creates the first fencing generation", async () => {
  const { env, db } = makeEnv();
  const path = "/internal/session-locks/acquire";
  const response = await worker.fetch(await signedRequest(path, {
    session_id: "telegram-user-42",
    locked_by: "instance-owner-000001",
    lease_seconds: 90,
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    acquired: true,
    expires_at: db.statements[0].values[2],
    fencing_token: 1,
  });
  assert.match(db.statements[0].sql, /ON CONFLICT\s*\(session_id\) DO UPDATE/i);
  assert.match(db.statements[0].sql, /session_locks\.fencing_token\s*\+\s*1/i);
  assert.doesNotMatch(db.statements[0].sql, /CASE\s+WHEN\s+session_locks\.locked_by/i);
});

test("renew and release require the current fencing token", async () => {
  const { env, db } = makeEnv();
  const acquire = await worker.fetch(await signedRequest("/internal/session-locks/acquire", {
    session_id: "telegram-user-42",
    locked_by: "instance-owner-000001",
    lease_seconds: 90,
  }), env);
  assert.equal(acquire.status, 200);

  const renew = await worker.fetch(await signedRequest("/internal/session-locks/renew", {
    session_id: "telegram-user-42",
    locked_by: "instance-owner-000001",
    lease_seconds: 90,
    fencing_token: 1,
  }), env);
  assert.equal(renew.status, 200);
  assert.deepEqual(await renew.json(), {
    renewed: true,
    expires_at: db.statements[1].values[0],
    fencing_token: 1,
  });
  assert.match(db.statements[1].sql, /fencing_token\s*=\s*\?/i);

  const release = await worker.fetch(await signedRequest("/internal/session-locks/release", {
    session_id: "telegram-user-42",
    locked_by: "instance-owner-000001",
    fencing_token: 1,
  }), env);
  assert.equal(release.status, 200);
  assert.deepEqual(await release.json(), { released: true });
  assert.match(db.statements[2].sql, /fencing_token\s*=\s*\?/i);
  assert.match(db.statements[2].sql, /^UPDATE session_locks SET expires_at = \?/i);
  assert.doesNotMatch(db.statements[2].sql, /^DELETE FROM session_locks/i);
});

test("release preserves fencing history and stale owners cannot mutate a newer lease", async () => {
  const { env, db } = makeEnv();
  const acquirePath = "/internal/session-locks/acquire";
  const first = await worker.fetch(await signedRequest(acquirePath, {
    session_id: "telegram-user-42", locked_by: "instance-owner-000001", lease_seconds: 90,
  }), env);
  assert.deepEqual(await first.json(), {
    acquired: true,
    expires_at: db.statements[0].values[2],
    fencing_token: 1,
  });

  const release = await worker.fetch(await signedRequest("/internal/session-locks/release", {
    session_id: "telegram-user-42", locked_by: "instance-owner-000001", fencing_token: 1,
  }), env);
  assert.deepEqual(await release.json(), { released: true });
  assert.equal(db.lockRows.get("telegram-user-42").fencing_token, 1);

  const second = await worker.fetch(await signedRequest(acquirePath, {
    session_id: "telegram-user-42", locked_by: "instance-owner-000002", lease_seconds: 90,
  }), env);
  assert.deepEqual(await second.json(), {
    acquired: true,
    expires_at: db.statements[2].values[2],
    fencing_token: 2,
  });

  const staleRenew = await worker.fetch(await signedRequest("/internal/session-locks/renew", {
    session_id: "telegram-user-42", locked_by: "instance-owner-000001",
    lease_seconds: 90, fencing_token: 1,
  }), env);
  assert.equal(staleRenew.status, 409);
  assert.deepEqual(await staleRenew.json(), { renewed: false });

  const staleRelease = await worker.fetch(await signedRequest("/internal/session-locks/release", {
    session_id: "telegram-user-42", locked_by: "instance-owner-000001", fencing_token: 1,
  }), env);
  assert.deepEqual(await staleRelease.json(), { released: false });
  assert.equal(db.lockRows.get("telegram-user-42").locked_by, "instance-owner-000002");
  assert.equal(db.lockRows.get("telegram-user-42").fencing_token, 2);
});

test("reacquiring with the same owner still advances the fencing generation", async () => {
  const { env, db } = makeEnv();
  const path = "/internal/session-locks/acquire";
  const payload = {
    session_id: "telegram-user-42",
    locked_by: "instance-owner-000001",
    lease_seconds: 90,
  };
  const first = await worker.fetch(await signedRequest(path, payload), env);
  const second = await worker.fetch(await signedRequest(path, payload), env);

  assert.deepEqual(await first.json(), {
    acquired: true, expires_at: db.statements[0].values[2], fencing_token: 1,
  });
  assert.deepEqual(await second.json(), {
    acquired: true, expires_at: db.statements[1].values[2], fencing_token: 2,
  });
});

test("session lock routes reject replayed HMAC nonces", async () => {
  const { env } = makeEnv();
  const nonce = "replay-nonce-000000000001";
  const first = await worker.fetch(await signedRequest("/internal/session-locks/acquire", {
    session_id: "telegram-user-42", locked_by: "instance-owner-000001", lease_seconds: 90,
  }, nonce), env);
  const second = await worker.fetch(await signedRequest("/internal/session-locks/acquire", {
    session_id: "telegram-user-42", locked_by: "instance-owner-000001", lease_seconds: 90,
  }, nonce), env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
});
