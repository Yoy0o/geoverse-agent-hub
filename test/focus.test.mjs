import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { createFocusService } from "../src/focus.js";

function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = createStore(db);
  const service = createFocusService(store, (tasks) => tasks.filter((t) => ["需介入", "待评审"].includes(t.status)).map((t) => ({ id: t.id, level: t.status })));
  const task = (id, extra = {}) => store.setDoc("tasks", id, { title: id, status: "执行中", goal: "Deliver a working query", updatedAt: "2026-10-27T00:00:00Z", ...extra });
  task("current"); task("previous", { status: "已合并", title: "Existing interface" });
  const update = (content) => service.update("current", { expectedFingerprint: service.get("current").fingerprint, content });
  const read = () => service.markRead("current", { expectedFingerprint: service.get("current").fingerprint });
  return { store, service, task, update, read };
}
const conflict = (fn) => assert.throws(fn, (e) => e.status === 409);
const invalid = (fn) => assert.throws(fn, (e) => e.status === 400);

test("legacy tasks are immediately readable without writes or a migration", (t) => {
  const { store, service } = fixture(t), version = store.getDoc("tasks", "current").version;
  const v = service.get("current");
  assert.equal(v.snapshot.summary, "Deliver a working query");
  assert.equal(v.firstRead, true);
  service.get("current"); service.context("current"); service.list();
  assert.equal(store.getDoc("tasks", "current").version, version);
});
test("all unread changes are relative to the explicit read snapshot", (t) => {
  const { service, update, read } = fixture(t);
  update({ summary: "A", nextAction: "Check input" }); read();
  update({ summary: "B", nextAction: "Check input" });
  update({ summary: "C", nextAction: "Build experiment" });
  const changes = service.get("current").changes;
  assert.deepEqual(changes.find((c) => c.field === "summary"), { field: "summary", label: "当前结论", before: "A", after: "C" });
  assert.equal(changes.find((c) => c.field === "nextAction").before, "Check input");
});

test("long legacy summaries stay concise without dropping the original evidence", (t) => {
  const { service, task } = fixture(t);
  const text = "Existing delivery. ".repeat(100);
  task("long", { receipt: { summary: text } });
  const view = service.get("long");
  assert.equal(view.snapshot.summary.length, 280);
  assert(view.snapshot.summary.endsWith("…"));
  assert.equal(view.snapshot.delivery.summary, text);
});
test("heartbeat, cost and unchanged summary writes do not create unread work", (t) => {
  const { store, service, update, read } = fixture(t);
  const content = { summary: "Ready for review", nextAction: "Review evidence" };
  update(content); read();
  const version = store.getDoc("tasks", "current").version;
  update(content);
  assert.equal(store.getDoc("tasks", "current").version, version);
  store.updateDoc("tasks", "current", { updatedAt: new Date().toISOString(), cost: 100, exec: { progress: 90, heartbeatAt: new Date().toISOString() } });
  assert.equal(service.get("current").unread, false);
});
test("marking read never resolves a decision or changes task acceptance", (t) => {
  const { store, service, update, read } = fixture(t);
  update({ decision: "Which scope?", recommendation: "Query first" });
  read();
  assert.equal(service.get("current").needsDecision, true);
  assert.equal(service.get("current").unread, false);
  assert.equal(store.getDoc("tasks", "current").data.status, "执行中");
  assert.equal(service.list().counts.attention, 1);
});
test("accepting a recommendation records a decision without execution or completion", (t) => {
  const { store, service, update } = fixture(t);
  const v = update({ decision: "Which scope?", recommendation: "Query first" });
  const accepted = service.decide("current", { expectedFingerprint: v.fingerprint, action: "accept" });
  assert.equal(accepted.needsDecision, false);
  assert.equal(accepted.unread, true);
  assert.equal(store.getDoc("tasks", "current").data.status, "执行中");
  assert.equal(store.listRuns({}).length, 0);
  const version = store.getDoc("tasks", "current").version;
  service.decide("current", { expectedFingerprint: v.fingerprint, action: "accept" });
  assert.equal(store.getDoc("tasks", "current").version, version);
});
test("new delivery evidence invalidates an old decision even when authored summary stays unchanged", (t) => {
  const { store, service, update, read } = fixture(t);
  const v = update({ summary: "Summary", decision: "Proceed?", recommendation: "Proceed" });
  service.decide("current", { expectedFingerprint: v.fingerprint, action: "accept" }); read();
  store.updateDoc("tasks", "current", { receipt: { summary: "New delivery", verify: [{ cmd: "check", result: "fail" }], risks: "Missing boundary check" } });
  const changed = service.get("current");
  assert.equal(changed.snapshot.summary, "Summary");
  assert.equal(changed.needsDecision, true);
  assert.equal(changed.resolutionStale, true);
  assert(changed.changes.some((c) => c.field === "delivery"));
});
test("stale update, read and decision requests cannot write over new business state", (t) => {
  const { store, service, update } = fixture(t), old = service.get("current").fingerprint;
  update({ summary: "New state", decision: "Scope?", recommendation: "Small scope" });
  const version = store.getDoc("tasks", "current").version;
  conflict(() => service.update("current", { expectedFingerprint: old, content: { summary: "Old state" } }));
  conflict(() => service.markRead("current", { expectedFingerprint: old }));
  conflict(() => service.decide("current", { expectedFingerprint: old, action: "accept" }));
  assert.equal(store.getDoc("tasks", "current").version, version);
});
test("relationships use existing IDs and preserve missing references without silently relinking", (t) => {
  const { store, service, update, read } = fixture(t);
  const rel = { taskId: "previous", type: "reuses", note: "Use the accepted interface" };
  update({ relations: [rel] }); read();
  store.updateDoc("tasks", "previous", { status: "执行中" });
  assert(service.get("current").changes.some((c) => c.field === "relations"));
  store.deleteDoc("tasks", "previous");
  assert.equal(service.get("current").snapshot.relations[0].status, "missing");
  assert.equal(service.list().counts.urgent, 1);
  invalid(() => update({ relations: [rel] }));
  invalid(() => update({ relations: [{ ...rel, taskId: "current" }] }));
});
test("invalid input and duplicate relationships are rejected without partial writes", (t) => {
  const { store, update } = fixture(t), version = store.getDoc("tasks", "current").version;
  const rel = { taskId: "previous", type: "reuses", note: "Reuse" };
  invalid(() => update({ relations: [rel, rel] }));
  invalid(() => update({ evidence: [{ label: "Bad", url: "javascript:alert(1)" }] }));
  invalid(() => update({ evidence: [{ label: "Bad", url: "https://user:password@example.com/" }] }));
  invalid(() => update({ summary: "x".repeat(281) }));
  invalid(() => update({ recommendation: "An unbound recommendation" }));
  assert.equal(store.getDoc("tasks", "current").version, version);
});
test("requirement changes invalidate a decision and read snapshot", (t) => {
  const { store, service, update, read } = fixture(t);
  const v = update({ summary: "Agreed", decision: "Proceed?", recommendation: "Proceed" });
  service.decide("current", { expectedFingerprint: v.fingerprint, action: "accept" }); read();
  store.updateDoc("tasks", "current", { acceptance: [{ text: "New boundary", done: false }] });
  assert.equal(service.get("current").needsDecision, true);
  assert(service.get("current").changes.some((c) => c.field === "requirements"));
});
test("revision requests require an explanation and remain actionable", (t) => {
  const { service, update } = fixture(t);
  const v = update({ decision: "Proceed?", recommendation: "Proceed" });
  invalid(() => service.decide("current", { expectedFingerprint: v.fingerprint, action: "revise" }));
  const r = service.decide("current", { expectedFingerprint: v.fingerprint, action: "revise", note: "Add a failure case" });
  assert.equal(r.needsDecision, true);
  assert.match(service.context("current").brief, /Add a failure case/);
});
test("normal actions are limited while all urgent items and unresolved closed-task decisions remain visible", (t) => {
  const { service, task } = fixture(t);
  for (let i = 0; i < 5; i++) task("blocked" + i, { status: "需介入" });
  for (let i = 0; i < 4; i++) task("review" + i, { status: "待评审" });
  let result = service.list();
  assert.equal(result.items.length, 5);
  assert.equal(result.counts.urgent, 5);
  assert.equal(result.remaining.length, 4);
  service.update("previous", { expectedFingerprint: service.get("previous").fingerprint, content: { decision: "Revisit interface?", recommendation: "Review the new requirement" } });
  result = service.list();
  assert([...result.items, ...result.remaining].some((v) => v.id === "previous"));
});

test("failed verification and scope checks stay visible even without a written risk", (t) => {
  const { service, task } = fixture(t);
  for (let i = 0; i < 4; i++) task("review" + i, { status: "待评审" });
  task("failed", { lastCheck: { ok: false } });
  task("scope", { lastCheck: { ok: true, outOfScope: ["outside.js"] } });
  task("receipt", { receipt: { verify: [{ cmd: "npm test", result: "fail" }] } });
  task("closed", { status: "已合并", lastCheck: { ok: false } });
  const result = service.list({ limit: 1 });
  assert.equal(result.counts.urgent, 3);
  assert.deepEqual(result.items.map((v) => v.id).sort(), ["failed", "receipt", "scope"]);
  assert(result.items.every((v) => v.reason === "验证未通过"));
});
