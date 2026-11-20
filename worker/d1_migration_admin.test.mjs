import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.mjs";

const SECRET = "migration-admin-test-secret-32-bytes";
const EXPECTED_LEDGER = [
  "0001_telegram_sessions.sql",
  "0002_telegram_auth_challenges.sql",
  "0003_manual_review_items.sql",
  "0004_panel_requests.sql",
  "0006_manual_review_spawn_context.sql",
];

function createMigrationDb() {
  const state = {
    tables: ["_cf_KV", "d1_migrations", "manual_review_items", "panel_requests", "sqlite_sequence", "telegram_auth_challenges", "telegram_sessions"],
    ledger: [...EXPECTED_LEDGER],
    executed: [],
  };
  return {
    state,
    async exec(sql) {
      state.executed.push(sql);
      for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)) {
        if (!state.tables.includes(match[1])) state.tables.push(match[1]);
      }
    },
    prepare(sql) {
      if (sql.startsWith("SELECT name FROM d1_migrations")) {
        return { all: async () => ({ results: state.ledger.map((name) => ({ name })) }) };
      }
      if (sql.startsWith("SELECT name FROM sqlite_master")) {
        return { all: async () => ({ results: state.tables.map((name) => ({ name })) }) };
      }
      if (sql.startsWith("INSERT INTO d1_migrations")) {
        return { bind: (name) => ({ run: async () => { state.ledger.push(name); return { success: true }; } }) };
      }
      throw new Error("unexpected migration query");
    },
  };
}

function migrationRequest(body, secret = SECRET) {
  return new Request("https://kagecatch-control.ahora-project.workers.dev/admin/d1-migrations", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const confirmation = {
  confirm: "APPLY_KAGECATCH_D1_SAFETY_MIGRATIONS",
  expected_ledger: EXPECTED_LEDGER,
};

test("D1 migration endpoint requires the Core admin secret", async () => {
  const db = createMigrationDb();
  const response = await worker.fetch(migrationRequest(confirmation, "wrong-secret"), {
    CORE_API_SECRET: SECRET,
    KAGECATCH_DB: db,
  });
  assert.equal(response.status, 401);
  assert.equal(db.state.executed.length, 0);
  assert.deepEqual(db.state.ledger, EXPECTED_LEDGER);
});

test("D1 migration endpoint refuses an unexpected live migration ledger", async () => {
  const db = createMigrationDb();
  db.state.ledger.push("unexpected_migration.sql");
  const response = await worker.fetch(migrationRequest(confirmation), {
    CORE_API_SECRET: SECRET,
    KAGECATCH_DB: db,
  });
  assert.equal(response.status, 409);
  assert.equal(db.state.executed.length, 0);
});

test("D1 migration endpoint applies only the three allowlisted missing safety migrations", async () => {
  const db = createMigrationDb();
  const response = await worker.fetch(migrationRequest(confirmation), {
    CORE_API_SECRET: SECRET,
    KAGECATCH_DB: db,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "ready");
  assert.deepEqual(result.applied, [
    "0005_telegram_bot_safety.sql",
    "0007_telegram_bot_chat_pacing.sql",
    "0008_telegram_bot_chat_circuit_breaker.sql",
  ]);
  assert.equal(result.required_tables, 3);
  assert.deepEqual(db.state.ledger, [
    ...EXPECTED_LEDGER,
    "0005_telegram_bot_safety.sql",
    "0007_telegram_bot_chat_pacing.sql",
    "0008_telegram_bot_chat_circuit_breaker.sql",
  ]);
  assert.equal(db.state.executed.length, 3);
});


test("D1 migration endpoint accepts the one-time deployment approval binding", async () => {
  const db = createMigrationDb();
  const response = await worker.fetch(migrationRequest(confirmation, ""), {
    KAGECATCH_D1_MIGRATION_APPROVAL: "APPLY_KAGECATCH_D1_SAFETY_MIGRATIONS",
    KAGECATCH_DB: db,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "ready");
  assert.equal(db.state.executed.length, 3);
});

test("D1 migration endpoint rejects an absent secret and absent one-time approval", async () => {
  const db = createMigrationDb();
  const response = await worker.fetch(migrationRequest(confirmation, ""), {
    KAGECATCH_DB: db,
  });
  assert.equal(response.status, 401);
  assert.equal(db.state.executed.length, 0);
});

test("D1 migration endpoint requires the exact confirmation phrase", async () => {
  const db = createMigrationDb();
  const response = await worker.fetch(migrationRequest({ ...confirmation, confirm: "yes" }), {
    CORE_API_SECRET: SECRET,
    KAGECATCH_DB: db,
  });
  assert.equal(response.status, 400);
  assert.equal(db.state.executed.length, 0);
});
