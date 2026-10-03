// 存储层的查询计划回归测试：高频查询必须走索引范围检索，不能全表扫描（Cloudflare 按扫描行数计费）
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";

function tracedStore() {
  const raw = new DatabaseSync(":memory:"); let last = "";
  const store = createStore({ exec: (q) => raw.exec(q), prepare: (q) => { last = q; return raw.prepare(q); } });
  const plan = (...params) => raw.prepare("EXPLAIN QUERY PLAN " + last).all(...params).map((r) => r.detail).join(" | ");
  return { raw, store, plan };
}
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

test("agent status reads only the recent window through the time index", () => {
  const { store, plan } = tracedStore();
  for (let i = 0; i < 500; i++) store.addEvent({ agent: i % 2 ? "codex" : "claude-code", kind: "tool", at: hoursAgo(30 + i) });
  store.addEvent({ agent: "codex", kind: "edit" });
  const since = hoursAgo(24);
  const rows = store.agentStatus(since);
  assert.deepEqual(rows.map((r) => [r.agent, r.n_recent]), [["codex", 1]]);
  const p = plan(since);
  assert.match(p, /SEARCH events USING (COVERING )?INDEX ev_at/);
  assert.doesNotMatch(p, /SCAN events/);
});

test("recent sessions and recent runs use range or ordered index access", () => {
  const { store, plan } = tracedStore();
  const since = hoursAgo(24 * 7);
  store.sessionsSince(since);
  assert.match(plan(since), /SEARCH sessions USING INDEX ss_last/);
  store.listRuns({ limit: 30 });
  assert.doesNotMatch(plan(30), /USE TEMP B-TREE FOR ORDER BY/);
  store.listRuns({ statuses: ["queued"], limit: 200 });
  assert.match(plan("queued", 200), /INDEX runs_status/);
});
