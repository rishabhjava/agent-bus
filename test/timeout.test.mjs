import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeoutMs } from "../lib/ask.mjs";
import { runCapture } from "../lib/util.mjs";

test("resolveTimeoutMs: default, floor, zero, and no ceiling", () => {
  assert.equal(resolveTimeoutMs(undefined), 240_000);
  assert.equal(resolveTimeoutMs(30), 30_000);
  assert.equal(resolveTimeoutMs(10), 30_000);
  assert.equal(resolveTimeoutMs(0), 0);
  assert.equal(resolveTimeoutMs(3600), 3_600_000);
  assert.equal(resolveTimeoutMs(86_400), 86_400_000);
});

test("runCapture: timeout kills the child and reports timedOut", async () => {
  const started = Date.now();
  const res = await runCapture("sleep", ["30"], { timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
});

test("runCapture: timeoutMs 0 disables the bus-side timer", async () => {
  const res = await runCapture("sh", ["-c", "sleep 1; echo done"], { timeoutMs: 0 });
  assert.equal(res.timedOut, false);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /done/);
});
