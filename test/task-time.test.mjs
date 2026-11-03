import { test } from "node:test";
import assert from "node:assert/strict";
import { activeMs, nextClock } from "../src/task-time.js";

test("workflow clock excludes pause, ready, review and blocked intervals across repeated resumes", () => {
  const iso = n => new Date(n).toISOString();
  let t = { status: "执行中", workClock: nextClock(null, "执行中", iso(1000)) };
  const move = (status, at) => { t = { status, workClock: nextClock(t, status, iso(at)) }; };
  assert.equal(activeMs(t, 3000), 2000);
  move("已暂停", 3000); assert.equal(activeMs(t, 900000), 2000);
  move("待执行", 900000); assert.equal(activeMs(t, 990000), 2000);
  move("执行中", 990000); move("需介入", 991000); assert.equal(activeMs(t, 999000), 3000);
  move("执行中", 999000); move("待评审", 1000000); move("已合并", 2000000);
  assert.equal(activeMs(t, 3000000), 4000); assert.equal(t.workClock.partial, false);
});
test("legacy tasks never convert days of wall time into invented active work", () => {
  const old = { status: "执行中", startedAt: "2020-01-01T00:00:00Z" };
  assert.equal(activeMs(old), null);
  const at = "2026-10-30T00:00:00Z", c = nextClock(old, "已暂停", at);
  assert.equal(c.activeMs, 0); assert.equal(c.runningSince, null); assert.equal(c.partial, true);
  assert.equal(c.trackedSince, at);
  const fresh = { status: "执行中", workClock: nextClock(null, "执行中", at) };
  assert.equal(nextClock(fresh, "执行中", "2026-10-31T00:00:00Z"), fresh.workClock);
  assert.equal(activeMs(fresh, Date.parse(at) - 1000), 0);
});
