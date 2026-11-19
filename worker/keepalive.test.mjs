import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.mjs";

test("Render keepalive uses a bounded request timeout and disables intermediary caching", async () => {
  let captured;
  const result = await worker.scheduled(
    { cron: "*/10 * * * *", scheduledTime: Date.now() },
    {
      FETCH: async (url, init) => {
        captured = { url, init };
        return new Response("alive", { status: 200 });
      },
    },
  );

  assert.equal(captured.url, "https://kagecatch-core-preview.onrender.com/healthz");
  assert.equal(captured.init.method, "GET");
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.equal(captured.init.signal.aborted, false);
  assert.equal(captured.init.headers["cache-control"], "no-cache");
  assert.deepEqual(result, { status: 200, ok: true });
});

test("Render keepalive logs only a safe error name when the upstream request fails", async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const result = await worker.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now() },
      {
        FETCH: async () => {
          throw Object.assign(new Error("private upstream detail"), { name: "NetworkError" });
        },
      },
    );

    assert.deepEqual(result, { status: 0, ok: false });
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0]);
    assert.equal(event.event, "render_keepalive");
    assert.equal(event.error_name, "NetworkError");
    assert.equal(event.ok, false);
    assert.doesNotMatch(logs[0], /private upstream detail/);
  } finally {
    console.error = originalError;
  }
});

test("Render keepalive skips unrelated scheduled events", async () => {
  let calls = 0;
  const result = await worker.scheduled(
    { cron: "0 * * * *", scheduledTime: Date.now() },
    { FETCH: async () => { calls += 1; return new Response("alive"); } },
  );

  assert.deepEqual(result, { skipped: true, reason: "not_render_keepalive_schedule" });
  assert.equal(calls, 0);
});
