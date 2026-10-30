import { z } from "zod";
import { getDoc, listDocs, updateDoc, transaction, listRuns, getRun, getRunner, addEvent } from "#hub/db";
import { getTask, moveTask } from "./domain.js";
import { createFocusService, fingerprintSchema } from "./focus.js";
import { RUN_ACTIVE, requestPauseStop, runnerOnline, runUpdate, httpError } from "./exec.js";
import { activeMs } from "./task-time.js";

const focus = createFocusService({ getDoc, listDocs, updateDoc, transaction });
const short = max => z.string().trim().min(1).max(max);
export const pauseShape = {
  expectedFingerprint: fingerprintSchema, reason: short(200), summary: short(280), nextAction: short(200),
  interruptedBy: z.string().trim().max(200).default(""),
};
export const resumeShape = { expectedFingerprint: fingerprintSchema, confirmedExternalStop: z.boolean().default(false) };
function parse(shape, input) {
  const r = z.object(shape).strict().safeParse(input);
  if (!r.success) throw httpError(400, r.error.issues.map(e => e.message).join("；"));
  return r.data;
}
function current(id, expected) {
  const t = getTask(id); if (!t) throw httpError(404, "找不到任务 " + id);
  if (focus.get(id).fingerprint !== expected) throw httpError(409, "工作内容已有变化，本次未写入；请重新读取上下文并核对断点");
  return t;
}
export function pauseExecution(t) {
  const pending = [], manual = [];
  for (const id of t.pauseState?.runIds || []) {
    const r = getRun(id);
    if (!r || r.task !== t.id || t.pauseState?.externalRunIds?.includes(id) || r.status === "lost") { manual.push(id); continue; }
    if (!RUN_ACTIVE.includes(r.status)) continue;
    if (r.mode === "exec" && r.runner && runnerOnline(getRunner(r.runner))) pending.push(id);
    else manual.push(id);
  }
  return { pending, manual, state: pending.length ? "stopping" : manual.length ? "external" : "stopped",
    message: pending.length ? "任务已暂停，等待执行端确认停止 Agent" : manual.length ? "任务已暂停；请在原会话或机器停止 Agent，Hub 无法确认外部进程" : "没有待停止的执行；恢复任务后需另行开工" };
}
export function lifecycleView(id) {
  const t = getTask(id); if (!t) throw httpError(404, "找不到任务 " + id);
  const v = focus.get(id);
  return { id, status: t.status, expectedFingerprint: v.fingerprint, content: v.content,
    summary: v.snapshot.summary, nextAction: v.snapshot.nextAction, checkpoint: t.pauseState || null,
    execution: t.status === "已暂停" ? pauseExecution(t) : null, activeMs: activeMs(t), partialTime: t.workClock?.partial ?? true,
    resumeTasks: listDocs("tasks").filter(d => d.data.status === "已暂停" && d.data.pauseState?.interruptedBy === id)
      .map(d => ({ id: d.id, title: d.data.title, nextAction: d.data.pauseState.nextAction })) };
}
export function pauseTask(id, input, origin = "human") {
  const b = parse(pauseShape, input);
  transaction(() => {
    const t = current(id, b.expectedFingerprint);
    if (!["待执行", "执行中", "需介入"].includes(t.status)) throw httpError(409, "只有待执行、执行中或需介入的任务可以暂停");
    if (b.interruptedBy) {
      const other = getTask(b.interruptedBy);
      if (!other || ["已合并", "已放弃"].includes(other.status)) throw httpError(400, "插单必须是尚未结束的已有任务");
      const seen = new Set([id]); let p = other;
      while (p) {
        if (seen.has(p.id)) throw httpError(400, "插单关系不能指向自己或形成循环");
        seen.add(p.id); p = p.status === "已暂停" && p.pauseState?.interruptedBy ? getTask(p.pauseState.interruptedBy) : null;
      }
    }
    const active = listRuns({ task: id, statuses: RUN_ACTIVE, limit: 1000 });
    const runs = active.map(r => r.id), externalRunIds = active.filter(r => r.mode !== "exec" || !r.runner).map(r => r.id);
    if (t.exec?.run && RUN_ACTIVE.includes(t.exec.status) && !runs.includes(t.exec.run)) { runs.push(t.exec.run); externalRunIds.push(t.exec.run); }
    const at = new Date().toISOString();
    moveTask(t, "已暂停", { pauseState: { at, fromStatus: t.status, reason: b.reason, summary: b.summary, nextAction: b.nextAction, interruptedBy: b.interruptedBy, runIds: runs, externalRunIds },
      focus: { ...t.focus, content: { ...focus.get(id).content, summary: b.summary, nextAction: b.nextAction }, updatedAt: at, updatedBy: origin } }, origin, true);
    addEvent({ agent: origin, kind: "pause", task: id, summary: "保存断点并暂停：" + b.reason });
  });
  requestPauseStop(id);
  return lifecycleView(id);
}
export function resumeTask(id, input, origin = "human") {
  const b = parse(resumeShape, input);
  transaction(() => {
    const t = current(id, b.expectedFingerprint);
    if (t.status !== "已暂停" || !t.pauseState) throw httpError(409, "任务没有可恢复的暂停断点");
    const execution = pauseExecution(t);
    if (execution.pending.length) throw httpError(409, "执行端尚未确认停止，请等待停止确认后再恢复");
    if (execution.manual.length && !b.confirmedExternalStop) throw httpError(409, "请先在外部停止 Agent，并明确确认后恢复");
    if (execution.manual.length) for (const rid of execution.manual) if (getRun(rid)?.task === id) runUpdate(rid, { status: "cancelled", note: "由 " + origin + " 确认外部执行已停止" }, origin);
    const at = new Date().toISOString();
    moveTask(t, "待执行", { pauseState: { ...t.pauseState, resumedAt: at, resumedBy: origin, ...(execution.manual.length ? { externalStopConfirmedAt: at } : {}) } }, origin, true);
    addEvent({ agent: origin, kind: "resume", task: id, summary: "恢复为待执行；第一步：" + t.pauseState.nextAction });
  });
  return { ...lifecycleView(id), context: focus.context(id).brief };
}
