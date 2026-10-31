// 多端同步冲突合并的单元测试（纯函数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTask, mergeConfig, resolveConflict } from "../src/merge.js";
import { versionReceipt, deliveryContext, requirementsHash } from "../src/delivery.js";

const h = (at, from, to) => ({ at, from, to });

test('sync retains independent delivery facts without transferring an old review to a newer version',()=>{
  const base={id:'T-sync',status:'待评审',goal:'Routing',acceptance:[],history:[]};
  const first=versionReceipt(base,{summary:'First',version:'v1',status:'done',verify:[],scope:'ok'},'local');
  first.revision.at=first.patch.receipt.at='2026-10-30T09:00:00Z';
  const local={...base,...first.patch,status:'已合并',history:[h('2026-10-30T10:00:00Z','待评审','已合并')],deliveryReviews:[{id:'R-1',at:'2026-10-30T10:00:00Z',action:'merge',deliveryId:first.revision.id,requirementsHash:requirementsHash(base),checkId:''}]};
  const second=versionReceipt({...base,...first.patch},{summary:'Second',version:'v2',status:'done',verify:[],scope:'ok'},'remote');
  second.patch.receipt.at='2026-10-31T10:00:00Z';second.revision.at=second.patch.receipt.at;
  const remote={...base,...second.patch,deliveryChecks:[{id:'C-1',at:'2026-10-31T10:00:00Z',version:'v2',requirementsHash:requirementsHash(base),ok:true}]};
  const merged=mergeTask(local,remote,'2026-10-30T10:00:00Z','2026-10-31T10:00:00Z');
  assert.equal(merged.deliveries.length,2);assert.equal(merged.deliveryReviews.length,1);assert.equal(merged.deliveryChecks.length,1);
  assert.equal(merged.currentDelivery,second.revision.id);assert.equal(deliveryContext(merged).accepted,false);
  assert.deepEqual(mergeTask(remote,local,'2026-10-31T10:00:00Z','2026-10-30T10:00:00Z').deliveries,merged.deliveries);
});

test('a later unrelated edit cannot restore the old running clock over a paused checkpoint',()=>{
  const paused={status:'已暂停',history:[h('2026-10-30T10:00:00Z','执行中','已暂停')],workClock:{activeMs:5000,runningSince:null},pauseState:{summary:'Saved checkpoint'}};
  const active={status:'执行中',history:[],title:'Later title',workClock:{activeMs:0,runningSince:'2026-10-30T09:00:00Z'}};
  const merged=mergeTask(paused,active,'2026-10-30T10:00:00Z','2026-10-30T11:00:00Z');
  assert.equal(merged.status,'已暂停');assert.deepEqual(merged.workClock,paused.workClock);assert.deepEqual(merged.pauseState,paused.pauseState);
});

test("a newer read marker cannot overwrite another peer's newer work summary", () => {
  const local = { status: "执行中", focus: { content: { summary: "New conclusion" }, updatedAt: "2026-10-27T10:00:00Z", read: { at: "2026-10-27T08:00:00Z", fingerprint: "old" } } };
  const remote = { status: "执行中", focus: { content: { summary: "Old conclusion" }, updatedAt: "2026-10-27T09:00:00Z", read: { at: "2026-10-27T11:00:00Z", fingerprint: "read-on-other-device" }, decisionResolution: { at: "2026-10-27T11:01:00Z", action: "accept", fingerprint: "old" } } };
  const merged = mergeTask(local, remote, "2026-10-27T10:00:00Z", "2026-10-27T11:01:00Z");
  assert.equal(merged.focus.content.summary, "New conclusion");
  assert.equal(merged.focus.read.fingerprint, "read-on-other-device");
  assert.equal(merged.focus.decisionResolution.fingerprint, "old");
});

test("task merge keeps both histories and takes status from the latest transition", () => {
  const base = { title: "导出", history: [h("2026-10-01T00:00:00Z", "", "待执行")] };
  const local = { ...base, goal: "本端目标", updatedAt: "2026-10-01T10:00:00Z", status: "待评审", history: [...base.history, h("2026-10-01T09:00:00Z", "待执行", "执行中"), h("2026-10-01T10:00:00Z", "执行中", "待评审")], receipt: { summary: "本端回执", at: "2026-10-01T10:00:00Z" } };
  const remote = { ...base, goal: "对端目标", updatedAt: "2026-10-01T11:00:00Z", status: "执行中", history: [...base.history, h("2026-10-01T09:00:00Z", "待执行", "执行中")] };
  const m = mergeTask(local, remote);
  assert.equal(m.status, "待评审", "a later status transition must not be lost to a later field edit");
  assert.equal(m.goal, "对端目标", "plain fields come from the later edit");
  assert.equal(m.history.length, 3);
  assert.equal(m.receipt.summary, "本端回执");
  assert.equal(m.updatedAt, "2026-10-01T11:00:00.000Z");
});

test("task merge unions reworks, ORs acceptance ticks and keeps the newer execution summary", () => {
  const acc = [{ text: "a", done: false }, { text: "b", done: false }];
  const local = { acceptance: [{ text: "a", done: true }, acc[1]], reworks: [{ at: "2026-10-01T01:00:00Z", reasons: ["验证不足"] }], exec: { run: "run-1", status: "running", at: "2026-10-01T05:00:00Z" }, updatedAt: "2026-10-01T05:00:00Z" };
  const remote = { acceptance: [acc[0], { text: "b", done: true }], reworks: [{ at: "2026-10-01T02:00:00Z", reasons: ["越界改动"] }], exec: { run: "run-1", status: "done", at: "2026-10-01T06:00:00Z" }, updatedAt: "2026-10-01T04:00:00Z" };
  const m = mergeTask(local, remote);
  assert.deepEqual(m.acceptance.map((a) => a.done), [true, true]);
  assert.equal(m.reworks.length, 2);
  assert.equal(m.exec.status, "done");
});

test("terminal status keeps doneAt and drop reason from the side that closed the task", () => {
  const local = { status: "已放弃", dropReason: "需求取消", doneAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", history: [h("2026-10-02T00:00:00Z", "执行中", "已放弃")] };
  const remote = { status: "执行中", title: "改了标题", updatedAt: "2026-10-02T01:00:00Z", history: [] };
  const m = mergeTask(local, remote);
  assert.equal(m.status, "已放弃");
  assert.equal(m.dropReason, "需求取消");
  assert.equal(m.doneAt, "2026-10-02T00:00:00Z");
  assert.equal(m.title, "改了标题");
});

test("config merge unions agents and projects by name", () => {
  const m = mergeConfig({ agents: ["Codex"], projects: [{ name: "a", path: "/local/a" }] }, { agents: ["Codex", "Kiro"], projects: [{ name: "a", path: "/cloud/a" }, { name: "b" }] }, "2026-10-02T02:00:00Z", "2026-10-02T01:00:00Z");
  assert.deepEqual(m.agents, ["Codex", "Kiro"]);
  assert.deepEqual(m.projects.map((p) => p.name).sort(), ["a", "b"]);
  assert.equal(m.projects.find((p) => p.name === "a").path, "/local/a");
});

test("delete versus edit keeps the edit; rules keep the higher hit count", () => {
  const edited = { deleted: false, data: { title: "x" }, updatedAt: "2026-10-02T00:00:00Z" };
  assert.equal(resolveConflict("tasks", { deleted: true }, edited).deleted, false);
  assert.equal(resolveConflict("tasks", edited, { deleted: true }).data.title, "x");
  assert.equal(resolveConflict("tasks", { deleted: true }, { deleted: true }).deleted, true);
  const r = resolveConflict("rules", { deleted: false, data: { text: "old", hits: 5 }, updatedAt: "2026-10-01T00:00:00Z" }, { deleted: false, data: { text: "new", hits: 2 }, updatedAt: "2026-10-02T00:00:00Z" });
  assert.equal(r.data.text, "new");
  assert.equal(r.data.hits, 5);
});
