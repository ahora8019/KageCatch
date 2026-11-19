import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "./index.mjs";

const BOT_TOKEN = "owner-panel-test-bot-token";
const OWNER_ID = 7135051954;

function makeWebAppInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAEAA-owner-panel-test",
    user: JSON.stringify(user),
  });
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(checkString).digest("hex"));
  return params.toString();
}

function createDurableObjectState() {
  const values = new Map();
  let tail = Promise.resolve();
  let alarmAt = null;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async list({ prefix = "" } = {}) {
      return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix)));
    },
    async setAlarm(when) { alarmAt = when instanceof Date ? when.getTime() : when; },
    async getAlarm() { return alarmAt === null ? null : new Date(alarmAt); },
    async deleteAlarm() { alarmAt = null; },
    async transaction(callback) {
      const run = tail.then(() => callback(storage));
      tail = run.catch(() => {});
      return run;
    },
  };
  return { storage, get alarmAt() { return alarmAt; } };
}

async function createOwnerEnv() {
  const { ConnectionLinkStore } = await import("./index.mjs");
  const state = createDurableObjectState();
  const store = new ConnectionLinkStore(state);
  const binding = {
    idFromName: () => "connection-links-v1",
    get: () => ({
      fetch: (input, init) => store.fetch(input instanceof Request ? input : new Request(input, init)),
    }),
  };
  const env = {
    CONNECT_LINKS: binding,
    OWNER_TELEGRAM_ID: String(OWNER_ID),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  };
  await store.fetch(new Request("https://do.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: OWNER_ID, ownerTelegramId: String(OWNER_ID) }),
  }));
  return { env, store, state };
}

async function addMember(store, telegramUserId, firstName = "Member") {
  const response = await store.fetch(new Request("https://do.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      telegramUserId,
      ownerTelegramId: String(OWNER_ID),
    }),
  }));
  assert.equal(response.status, 200);
  const user = await response.json();
  user.firstName = firstName;
  await store.state.storage.put("user:" + telegramUserId, user);
  return user;
}

function apiRequest(action, payload = {}, user = { id: OWNER_ID, first_name: "Owner" }) {
  const initData = makeWebAppInitData(user);
  return new Request("https://kagecatch-control.ahora-project.workers.dev/api/owner/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData, action, ...payload }),
  });
}

test("Owner control API rejects missing, forged, expired, and non-Owner Mini App identity", async () => {
  const { env, store } = await createOwnerEnv();
  await addMember(store, 123456789, "Member");

  const missing = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/owner/control", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dashboard" }),
  }), env);
  assert.equal(missing.status, 401);

  const forgedData = new URLSearchParams(makeWebAppInitData({ id: OWNER_ID }));
  forgedData.set("user", JSON.stringify({ id: 123456789 }));
  const forged = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/owner/control", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dashboard", initData: forgedData.toString() }),
  }), env);
  assert.equal(forged.status, 401);

  const expiredUser = { id: OWNER_ID, first_name: "Owner" };
  const expiredData = makeWebAppInitData(expiredUser, Math.floor(Date.now() / 1000) - 86401);
  const expired = await worker.fetch(new Request("https://kagecatch-control.ahora-project.workers.dev/api/owner/control", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dashboard", initData: expiredData }),
  }), env);
  assert.equal(expired.status, 401);

  const member = await worker.fetch(apiRequest("dashboard", {}, { id: 123456789, first_name: "Member" }), env);
  assert.equal(member.status, 403);
});

test("Owner dashboard returns bounded, sanitized registry, invitation, and broadcast summaries", async () => {
  const { env, store, state } = await createOwnerEnv();
  await addMember(store, 123456789, "Sakura");
  await addMember(store, 123456790, "Blocked");
  await store.fetch(new Request("https://do.internal/manage-user", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegramUserId: 123456790, action: "block" }),
  }));
  const createdInvite = await store.fetch(new Request("https://do.internal/invite/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxUses: 1, ttlSeconds: 86400 }),
  }));
  const invite = await createdInvite.json();
  await state.storage.put("broadcast:" + OWNER_ID, {
    status: "review_required",
    text: "private broadcast body must not be returned",
    recipientIds: [123456789, 123456790],
    nextIndex: 1,
    deliveredCount: 1,
    failedCount: 0,
    reviewIndex: 1,
    reviewRecipientId: 123456790,
    reviewReason: "ambiguous_delivery",
    reviewAttemptId: "123e4567-e89b-12d3-a456-426614174000",
    updatedAt: Date.now(),
  });

  const response = await worker.fetch(apiRequest("dashboard"), env);
  assert.equal(response.status, 200);
  const raw = await response.text();
  const result = JSON.parse(raw);
  assert.deepEqual(result.counts, {
    members: 2, active_members: 1, blocked_members: 1, usable_invites: 1,
  });
  assert.equal(result.members.length, 2);
  assert.equal(result.members.find((member) => member.telegram_user_id === 123456790).status, "blocked");
  assert.equal(result.invites[0].id, invite.id);
  assert.equal(result.invites[0].usable, true);
  assert.equal(result.broadcast.status, "review_required");
  assert.equal(result.broadcast.recipient_count, 2);
  assert.equal(result.broadcast.review_recipient_id, 123456790);
  assert.doesNotMatch(raw, /private broadcast body|tokenHash|recipientIds|session_string|phone_number/);
  assert.equal(raw.includes(invite.token), false);
});

test("Owner can block and restore MEMBER access, but the Owner identity is protected", async () => {
  const { env, store } = await createOwnerEnv();
  await addMember(store, 123456789, "Sakura");

  const blocked = await worker.fetch(apiRequest("member_status", {
    telegramUserId: 123456789,
    memberAction: "block",
    confirmation: "BLOCK_MEMBER",
  }), env);
  assert.equal(blocked.status, 200);
  assert.equal((await blocked.json()).member.status, "blocked");

  const restored = await worker.fetch(apiRequest("member_status", {
    telegramUserId: 123456789,
    memberAction: "unblock",
    confirmation: "UNBLOCK_MEMBER",
  }), env);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).member.status, "active");

  const protectedOwner = await worker.fetch(apiRequest("member_status", {
    telegramUserId: OWNER_ID,
    memberAction: "block",
    confirmation: "BLOCK_MEMBER",
  }), env);
  assert.equal(protectedOwner.status, 403);

  const missingConfirmation = await worker.fetch(apiRequest("member_status", {
    telegramUserId: 123456789,
    memberAction: "block",
  }), env);
  assert.equal(missingConfirmation.status, 400);
});

test("Owner can create and revoke bounded invitations through the Mini App", async () => {
  const { env, store } = await createOwnerEnv();

  const created = await worker.fetch(apiRequest("invite_create", {
    maxUses: 10, ttlSeconds: 604800,
  }), env);
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.match(result.link, /^https:\/\/t\.me\/KageCatchBot\?start=inv_[A-Za-z0-9_-]+$/);
  assert.equal(result.invite.max_uses, 10);

  const revoked = await worker.fetch(apiRequest("invite_revoke", {
    inviteId: result.invite.id, confirmation: "REVOKE_INVITE",
  }), env);
  assert.equal(revoked.status, 200);
  const { invites } = await (await store.fetch(new Request("https://do.internal/invite/list", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }))).json();
  assert.equal(invites[0].revokedAt !== null, true);

  const invalid = await worker.fetch(apiRequest("invite_create", {
    maxUses: 100, ttlSeconds: 86400,
  }), env);
  assert.equal(invalid.status, 400);
});

test("Owner broadcast review is fenced by the exact attempt and explicit decision", async () => {
  const { env, store, state } = await createOwnerEnv();
  await state.storage.put("broadcast:" + OWNER_ID, {
    status: "review_required",
    text: "notice",
    recipientIds: [123456789, 123456790],
    nextIndex: 0,
    deliveredCount: 0,
    failedCount: 0,
    reviewIndex: 0,
    reviewRecipientId: 123456789,
    reviewReason: "ambiguous_delivery",
    reviewAttemptId: "123e4567-e89b-12d3-a456-426614174000",
    updatedAt: Date.now(),
  });

  const stale = await worker.fetch(apiRequest("broadcast_resolve", {
    expectedIndex: 0,
    expectedAttemptId: "223e4567-e89b-12d3-a456-426614174000",
    decision: "delivered",
    confirmation: "MARK_DELIVERED",
  }), env);
  assert.equal(stale.status, 409);

  const missingConfirmation = await worker.fetch(apiRequest("broadcast_resolve", {
    expectedIndex: 0,
    expectedAttemptId: "123e4567-e89b-12d3-a456-426614174000",
    decision: "retry",
    confirmation: "MARK_DELIVERED",
  }), env);
  assert.equal(missingConfirmation.status, 400);

  const resolved = await worker.fetch(apiRequest("broadcast_resolve", {
    expectedIndex: 0,
    expectedAttemptId: "123e4567-e89b-12d3-a456-426614174000",
    decision: "delivered",
    confirmation: "MARK_DELIVERED",
  }), env);
  assert.equal(resolved.status, 200);
  const summary = (await resolved.json()).draft;
  assert.equal(summary.status, "queued");
  assert.equal(summary.next_index, 1);
  assert.equal(summary.delivered_count, 1);
  assert.equal(summary.review_attempt_id, null);
  assert.ok(state.alarmAt > Date.now());
});

test("Owner broadcast cancel is explicit and does not clear an in-flight recipient", async () => {
  const { env, state } = await createOwnerEnv();
  await state.storage.put("broadcast:" + OWNER_ID, {
    status: "queued",
    recipientIds: [123456789],
    nextIndex: 0,
    text: "notice",
  });

  const missingConfirmation = await worker.fetch(apiRequest("broadcast_cancel"), env);
  assert.equal(missingConfirmation.status, 400);

  const cleared = await worker.fetch(apiRequest("broadcast_cancel", {
    confirmation: "CANCEL_BROADCAST",
  }), env);
  assert.equal(cleared.status, 200);
  assert.equal(await state.storage.get("broadcast:" + OWNER_ID), undefined);

  await state.storage.put("broadcast:" + OWNER_ID, {
    status: "sending", inFlightAttemptId: "123e4567-e89b-12d3-a456-426614174000",
  });
  const inFlight = await worker.fetch(apiRequest("broadcast_cancel", {
    confirmation: "CANCEL_BROADCAST",
  }), env);
  assert.equal(inFlight.status, 409);
  assert.equal((await state.storage.get("broadcast:" + OWNER_ID)).status, "sending");
});
