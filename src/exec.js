// 执行管理：执行端（runner：本机、云端 VM、CI）与执行记录（run：一次执行尝试）。
// 任务单回答“做什么”，执行记录回答“在哪里做、做到哪一步、还活着吗”。
// 每个任务同一时间只有一个进行中的执行；它的摘要写在任务文档的 exec 字段里，随多端同步传到其他 Hub。
import crypto from "node:crypto";
import { bus, getRun, insertRun, updateRun, listRuns, getRunner, listRunners, upsertRunner, touchRunner, deleteRunner, addEvent, updateDoc, validId } from "#hub/db";
import { config } from "#hub/config";
import { OPEN, getTask, moveTask, patchTask, taskBrief } from "./domain.js";

export const RUN_ACTIVE = ["queued", "claimed", "ready", "running"];
export const RUN_MODES = ["exec", "prepare", "handoff", "manual"];
export const RUN_LABEL = { queued: "排队中", claimed: "已领取", ready: "待启动", running: "执行中", blocked: "阻塞", done: "已交付", failed: "失败", cancelled: "已取消", lost: "失联", superseded: "已替代", stalled: "停滞", waiting: "等待执行端" };
export const MODE_LABEL = { exec: "自动执行", prepare: "准备工作区", handoff: "交给 Agent", manual: "手动开工" };
const NOT_AGENTS = ["git", "task-sh", "human", "mcp", "runner", "hub", "exec", "sync"];

const nowIso = () => new Date().toISOString();
const clip = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const agentKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
const loc = (v, fallback = "local") => (v === "cloud" || v === "local" ? v : fallback);
const pct = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined; };
export const newRunId = () => "run-" + crypto.randomBytes(6).toString("hex");
export function httpError(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

/* ---------------- 状态与健康度 ---------------- */
export const runnerOnline = (r) => !!(r && r.lastSeen && Date.now() - Date.parse(r.lastSeen) < config.runnerOfflineSeconds * 1000);
// 存储的状态之外，再按心跳算出健康度：stalled（长时间没动静）、lost（执行端离线）、waiting（指定的执行端不在线）
export function runHealth(run, runner) {
  if (!run) return "";
  if (!RUN_ACTIVE.includes(run.status)) return run.status;
  if (run.status === "queued") return run.runner && !runnerOnline(runner) ? "waiting" : "queued";
  if (run.mode === "exec" && run.runner && !runnerOnline(runner)) return "lost";
  const last = Date.parse(run.heartbeatAt || run.startedAt || run.claimedAt || run.createdAt) || 0;
  return Date.now() - last > config.runStallMinutes * 60000 ? "stalled" : run.status;
}
function decorate(run, runners) {
  if (!run) return null;
  const rn = run.runner ? runners.get(run.runner) : null;
  return Object.assign({}, run, { health: runHealth(run, rn), runnerName: rn ? rn.name : "", runnerKind: rn ? rn.kind : "" });
}
const runnerMap = () => new Map(listRunners().map((r) => [r.id, r]));
export function runView(run) { return decorate(run, runnerMap()); }
export function runsView(opts) { const m = runnerMap(); return listRuns(opts).map((r) => decorate(r, m)); }
export function runnersView() {
  const active = listRuns({ statuses: RUN_ACTIVE, limit: 1000 });
  return listRunners().map((r) => Object.assign({}, r, { online: runnerOnline(r), active: active.filter((x) => x.runner === r.id).length }));
}
export function activeRun(taskId) { return listRuns({ task: taskId, statuses: RUN_ACTIVE, limit: 1 })[0] || null; }

/* ---------------- 任务文档里的执行摘要 ---------------- */
function syncExec(taskId, run) {
  const t = getTask(taskId); if (!t || !run) return;
  const rn = run.runner ? getRunner(run.runner) : null;
  const prev = t.exec && t.exec.run === run.id ? t.exec : {};
  const exec = {
    run: run.id, status: run.status, mode: run.mode, location: run.location, runner: run.runner, runnerName: rn ? rn.name : prev.runnerName || "",
    host: run.host || (rn ? rn.host : ""), agent: run.agent, progress: run.progress, step: run.step, note: run.note,
    heartbeatAt: run.heartbeatAt, startedAt: run.startedAt, endedAt: run.endedAt, attempts: listRuns({ task: taskId, limit: 1000 }).length, at: nowIso(),
  };
  updateDoc("tasks", taskId, { exec }, "exec");
}
// 心跳不必每次写任务文档：摘要超过 5 分钟（步骤变化时 1 分钟）才刷新，多端同步也因此保持安静
function maybeSyncExec(run) {
  const t = getTask(run.task); if (!t) return;
  const e = t.exec;
  const age = e && e.at ? Date.now() - Date.parse(e.at) : Infinity;
  if (!e || e.run !== run.id || age > (e.step !== run.step ? 60000 : 300000)) syncExec(run.task, run);
}
const KEY_FIELDS = ["status", "progress", "runner", "location", "exitCode", "receipt", "cancel", "mode"];
function applyRun(run, fields) {
  const changed = Object.keys(fields).some((k) => k !== "heartbeatAt" && fields[k] !== run[k]);
  const sinceBeat = Date.now() - (Date.parse(run.heartbeatAt || "") || 0);
  const out = updateRun(run.id, fields, { quiet: !changed && sinceBeat < 60000 });
  if (KEY_FIELDS.some((k) => k in fields && fields[k] !== run[k])) syncExec(out.task, out); else maybeSyncExec(out);
  return out;
}
function logRun(origin, run, summary, task) {
  addEvent({ agent: origin || "hub", kind: "run", raw: run.status, task: task || run.task, summary: clip(summary, 300) });
}

/* ---------------- 开始 / 接手 / 新建执行 ---------------- */
function createRun(t, o, origin) {
  // 同一任务只保留一个进行中的执行：新的执行开始时，旧的标记为“已替代”（执行端会停止自己启动的进程）
  for (const r of listRuns({ task: t.id, statuses: RUN_ACTIVE, limit: 50 })) {
    applyRun(r, { status: "superseded", endedAt: nowIso(), cancel: r.mode === "exec", note: "被新的执行替代" });
  }
  const at = nowIso();
  const run = insertRun(Object.assign({ id: newRunId(), task: t.id, createdAt: at, heartbeatAt: at, requestedBy: origin || "" }, o));
  syncExec(t.id, run);
  return run;
}
function sameRun(act, o) {
  if (act.status === "queued") return act.mode === "handoff";
  if (o.worktree && act.worktree) return o.worktree === act.worktree;
  if (o.session && act.session) return o.session === act.session;
  if (o.runner && act.runner) return o.runner === act.runner;
  return true;
}
/**
 * 任务在某处开工（task.sh start / attach、MCP start_task、钩子会话开始、执行端准备好工作区）。
 * 有对应的进行中执行就接手它，否则新建一条（旧的进行中执行标记为已替代）。
 */
export function startRun(t, o = {}, origin = "hub") {
  const at = nowIso();
  let run = o.run && validId(String(o.run)) ? getRun(String(o.run)) : null;
  if (run && (run.task !== t.id || !RUN_ACTIVE.includes(run.status))) run = null;
  if (!run) { const act = activeRun(t.id); if (act && sameRun(act, o)) run = act; }
  // 执行端派发的执行：task.sh 建好工作区后是“待启动”，Agent 真正开始（钩子 / 执行端回报）才算“执行中”
  const byRunner = run && ["exec", "prepare"].includes(run.mode) && ["queued", "claimed"].includes(run.status);
  const status = ["ready", "running"].includes(o.status) ? o.status : byRunner ? "ready" : "running";
  const agent = NOT_AGENTS.includes(agentKey(o.agent)) ? "" : agentKey(o.agent);
  const f = { status, heartbeatAt: at };
  if (status === "running") f.startedAt = (run && run.startedAt) || at;
  for (const k of ["branch", "worktree", "session", "host"]) if (o[k]) f[k] = clip(o[k], 300);
  if (o.runner && getRunner(String(o.runner))) f.runner = String(o.runner);
  if (agent) f.agent = agent;
  if (o.location) f.location = loc(o.location);
  if (o.step) f.step = clip(o.step);
  if (run) {
    if (run.status === "queued" || run.status === "claimed") { f.claimedAt = run.claimedAt || at; if (!f.step) f.step = status === "ready" ? "工作区已就绪，等待启动 Agent" : "已开工"; }
    const p = status === "ready" ? 10 : 15;
    if (run.progress == null || run.progress < p) f.progress = p;
    const out = applyRun(run, f);
    if (run.status !== out.status) logRun(origin, out, (out.location === "cloud" ? "云端" : "本机") + (status === "ready" ? "工作区已就绪" : "开始执行") + (out.host ? " · " + out.host : ""));
    return out;
  }
  const mode = RUN_MODES.includes(o.mode) ? o.mode : "manual";
  const out = createRun(t, Object.assign({ location: "local", mode, step: status === "ready" ? "工作区已就绪，等待启动 Agent" : "已开工", progress: status === "ready" ? 10 : 15, claimedAt: at }, f), origin);
  logRun(origin, out, (out.location === "cloud" ? "云端" : "本机") + "开始执行" + (out.host ? " · " + out.host : "") + (out.agent ? " · " + out.agent : ""));
  return out;
}

/* ---------------- 钩子、MCP、task.sh 的活动 → 心跳与步骤 ---------------- */
const STEP = {
  "session.start": "Agent 会话开始", "session.end": "Agent 会话结束", prompt: "收到新的指令", edit: "修改代码", tool: "运行工具", stop: "一轮结束",
  deny: "改动被守卫拦截", error: "出错", compact: "压缩上下文", subagent: "子任务", "spec.task": "完成一项 spec 任务", commit: "提交代码",
};
const CREATING = ["session.start", "prompt", "edit"];
export function touchFromEvent(t, e) {
  if (!t) return null;
  let run = e.run && validId(String(e.run)) ? getRun(String(e.run)) : null;
  if (run && (run.task !== t.id || !RUN_ACTIVE.includes(run.status))) run = null;
  if (!run) run = activeRun(t.id);
  const working = CREATING.includes(e.kind) && OPEN.includes(t.status) && t.status !== "待评审";
  if (!run || run.status === "queued") {
    if (!working) return run;
    return startRun(t, { run: run && run.mode === "handoff" ? run.id : "", runner: e.runner, location: e.location || (e.agent === "claude-ai" ? "cloud" : "local"), host: e.host, agent: e.agent, session: e.session, branch: e.branch, worktree: e.cwd }, e.agent);
  }
  const f = { heartbeatAt: nowIso() };
  if (["claimed", "ready"].includes(run.status) && ["session.start", "prompt", "edit", "tool"].includes(e.kind)) { f.status = "running"; if (!run.startedAt) f.startedAt = f.heartbeatAt; }
  if (e.session && !run.session) f.session = clip(e.session, 200);
  if (e.runner && !run.runner && getRunner(String(e.runner))) f.runner = String(e.runner);
  if (e.host && !run.host) f.host = clip(e.host, 120);
  if (e.cwd && !run.worktree) f.worktree = clip(e.cwd, 300);
  if (e.branch && !run.branch) f.branch = clip(e.branch, 200);
  const ak = agentKey(e.agent);
  if (ak && !run.agent && !NOT_AGENTS.includes(ak)) f.agent = ak;
  let step = STEP[e.kind];
  if (e.kind === "check" || e.kind === "commit" || e.kind === "error") step = clip(e.summary, 120) || step;
  if (step) f.step = step;
  const milestone = e.kind === "check" ? (/^检查通过/.test(e.summary || "") ? 80 : 60) : { "session.start": 15, edit: 30, commit: 50 }[e.kind];
  if (milestone && (run.progress == null || run.progress < milestone)) f.progress = milestone;
  return applyRun(run, f);
}

/* ---------------- 进度 ---------------- */
// 进度上报：MCP report_progress、hub.sh progress、task.sh progress。acceptance 是完成的验收标准序号（从 0 开始）
export function reportProgress(t, b = {}, origin = "hub") {
  let run = b.run && validId(String(b.run)) ? getRun(String(b.run)) : null;
  if (run && (run.task !== t.id || !RUN_ACTIVE.includes(run.status))) run = null;
  if (!run) run = activeRun(t.id);
  if (!run || run.status === "queued") run = startRun(t, { run: run ? run.id : "", agent: origin, location: b.location, host: b.host, runner: b.runner, session: b.session }, origin);
  const f = { heartbeatAt: nowIso() };
  const p = pct(b.progress);
  if (p !== undefined) f.progress = p;
  if (b.step) f.step = clip(b.step);
  if (b.note) f.note = clip(b.note, 500);
  if (run.status !== "running") { f.status = "running"; if (!run.startedAt) f.startedAt = f.heartbeatAt; }
  const idx = Array.isArray(b.acceptance) ? b.acceptance.map(Number).filter((i) => Number.isInteger(i) && i >= 0) : [];
  if (idx.length && (t.acceptance || []).length) {
    const acc = t.acceptance.map((a, i) => (idx.includes(i) ? Object.assign({}, a, { done: true }) : a));
    patchTask(t.id, { acceptance: acc }, origin);
    if (f.progress === undefined && (run.progress == null || run.progress < 90)) {
      const auto = Math.round((acc.filter((a) => a.done).length / acc.length) * 90);
      if (run.progress == null || auto > run.progress) f.progress = auto;
    }
  }
  const out = applyRun(run, f);
  if (out.step !== run.step && out.progress === run.progress) syncExec(out.task, out);
  addEvent({ agent: origin, kind: "progress", raw: "progress", task: t.id, summary: clip((out.progress != null ? "进度 " + out.progress + "%" : "进展") + (b.step ? " · " + b.step : "") + (b.note ? "：" + b.note : ""), 300) });
  return out;
}

/* ---------------- 派发（交给执行端或云端 Agent） ---------------- */
export function handoffPrompt(t) {
  return [
    `执行 agent-hub 任务 ${t.id}：${t.title || ""}`,
    `1. 先运行 \`bash scripts/agent/task.sh attach ${t.id}\`（绑定任务、拉取任务单、向 agent-hub 报告开工）；仓库里没有这个脚本时，调用 agent-hub MCP 的 start_task(id="${t.id}", location="cloud")。`,
    `2. 阅读 specs/${t.id}.md（或 get_task 的结果），按验收标准和允许修改的范围实现；阶段性进展用 \`bash scripts/agent/hub.sh progress <0-100> "<当前步骤>"\` 或 MCP report_progress 汇报。`,
    "3. 结束前运行 bash scripts/agent/verify.sh，按 AGENTS.md 输出交付回执，能用 agent-hub MCP 时同时调用 submit_receipt。",
  ].join("\n");
}
export function dispatch(t, b = {}, origin = "human") {
  if (["待评审", "已合并", "已放弃"].includes(t.status)) throw httpError(409, `任务处于「${t.status}」，不能派发；退回修改或重新打开后再派发`);
  const mode = ["exec", "prepare", "handoff"].includes(b.mode) ? b.mode : "prepare";
  let rn = null;
  if (b.runner && mode !== "handoff") {
    rn = getRunner(String(b.runner)); if (!rn) throw httpError(404, "找不到执行端 " + b.runner);
    if (mode === "exec" && rn.mode !== "exec") throw httpError(400, `执行端「${rn.name}」只准备工作区，不自动启动 Agent；改用“准备工作区”或在该机器上用 --exec 重新登记`);
    if (t.project && rn.projects.length && !rn.projects.includes(t.project)) throw httpError(400, `执行端「${rn.name}」没有登记项目「${t.project}」的本地路径`);
  }
  const act = activeRun(t.id);
  if (act && !b.force) throw httpError(409, `任务已有进行中的执行（${RUN_LABEL[act.status] || act.status}${act.host ? " · " + act.host : ""}）；先取消，或勾选“替换当前执行”`);
  const agent = agentKey(b.agent) || (rn && rn.agents[0]) || "";
  const run = createRun(t, {
    status: "queued", mode, runner: rn ? rn.id : "", agent, location: mode === "handoff" ? loc(b.location, "cloud") : rn && rn.kind !== "local" ? "cloud" : "local",
    host: rn ? rn.host : "", note: clip(b.note, 500), step: mode === "handoff" ? "等待 Agent 接手" : rn ? "等待「" + rn.name + "」领取" : "等待执行端领取", progress: 0,
  }, origin);
  logRun(origin, run, "派发：" + MODE_LABEL[mode] + (rn ? " → " + rn.name : mode === "handoff" ? (run.location === "cloud" ? " → 云端 Agent" : " → 手动启动的 Agent") : " → 任一执行端") + (agent ? " · " + agent : ""));
  return { run: runView(run), prompt: handoffPrompt(t) };
}
export function cancelRun(runId, origin = "human") {
  const run = getRun(runId); if (!run) throw httpError(404, "找不到执行记录 " + runId);
  if (!RUN_ACTIVE.includes(run.status)) return runView(run);
  const rn = run.runner ? getRunner(run.runner) : null;
  // 执行端正在跑的进程：先请求取消，执行端下一次心跳时停止进程；执行端离线或没有进程时直接结束
  if (run.mode === "exec" && ["claimed", "running"].includes(run.status) && runnerOnline(rn) && !run.cancel) {
    const out = applyRun(run, { cancel: true, step: "正在取消…" });
    logRun(origin, out, "请求取消执行");
    return runView(out);
  }
  const out = applyRun(run, { status: "cancelled", cancel: true, endedAt: nowIso(), step: "已取消" });
  logRun(origin, out, "已取消执行");
  return runView(out);
}

/* ---------------- 执行端 ---------------- */
export function registerRunner(b = {}) {
  const id = validId(String(b.id || "")) && String(b.id).length <= 64 ? String(b.id) : "rn-" + crypto.randomBytes(6).toString("hex");
  const list = (v, f) => (Array.isArray(v) ? v : String(v || "").split(",")).map(f).filter(Boolean).slice(0, 50);
  return upsertRunner({
    id, name: clip(b.name || b.host || id, 80), kind: ["local", "cloud", "ci"].includes(b.kind) ? b.kind : "local", host: clip(b.host, 120), platform: clip(b.platform, 60),
    agents: [...new Set(list(b.agents, agentKey))], projects: [...new Set(list(b.projects, (x) => clip(x, 100)))],
    mode: b.mode === "exec" ? "exec" : "prepare", maxRuns: Math.min(8, Math.max(1, Number(b.maxRuns || b.max) || 1)), version: clip(b.version, 20),
  });
}
export function removeRunner(id) {
  for (const r of listRuns({ runner: id, statuses: RUN_ACTIVE, limit: 100 })) applyRun(r, { status: r.status === "queued" ? "cancelled" : "lost", endedAt: nowIso(), note: "执行端已移除" });
  return deleteRunner(id);
}
function claimable(run, rn) {
  if (run.status !== "queued" || !["exec", "prepare"].includes(run.mode)) return false;
  if (run.mode === "exec" && rn.mode !== "exec") return false;
  if (run.runner) return run.runner === rn.id;
  const t = getTask(run.task);
  if (!t || (t.project && !rn.projects.includes(t.project))) return false;
  return !run.agent || !rn.agents.length || rn.agents.includes(run.agent);
}
// 执行端心跳：报告自己仍在跑的执行；返回需要停止的执行和可以领取的数量
export function runnerHeartbeat(id, b = {}) {
  const rn = touchRunner(id); if (!rn) throw httpError(404, "执行端未登记，请重新运行 runner.mjs register");
  const alive = new Set((Array.isArray(b.runs) ? b.runs : []).map((r) => String(r && r.id || r)));
  const cancel = [];
  for (const run of listRuns({ runner: id, statuses: RUN_ACTIVE, limit: 100 })) {
    if (run.cancel) { cancel.push(run.id); continue; }
    if (alive.has(run.id)) applyRun(run, { heartbeatAt: nowIso() });
    else if (run.mode === "exec" && ["claimed", "running"].includes(run.status)) {
      // 执行端重启后丢失了进程：这次执行没有结果
      const out = applyRun(run, { status: "lost", endedAt: nowIso(), note: "执行端重启或进程意外结束，没有上报结果" });
      logRun("runner", out, "执行失联：" + out.note);
      const t = getTask(run.task); if (t && t.status === "执行中") moveTask(t, "需介入", null, "runner");
    }
  }
  for (const rid of alive) { const run = getRun(rid); if (run && run.runner === id && !RUN_ACTIVE.includes(run.status)) cancel.push(rid); }
  const queued = listRuns({ statuses: ["queued"], limit: 200 }).filter((r) => claimable(r, rn)).length;
  return { ok: true, cancel: [...new Set(cancel)], queued, stallMinutes: config.runStallMinutes };
}
// 领取一条可执行的派发（最早的优先）；同步执行，同一 Hub 内不会被两个执行端同时领取
export function claimNext(id) {
  const rn = touchRunner(id); if (!rn) throw httpError(404, "执行端未登记，请重新运行 runner.mjs register");
  const queued = listRuns({ statuses: ["queued"], limit: 200 }).reverse();
  for (const run of queued) {
    if (!claimable(run, rn)) continue;
    const t = getTask(run.task);
    if (!t || ["已合并", "已放弃"].includes(t.status)) { applyRun(run, { status: "cancelled", endedAt: nowIso(), note: "任务已结束" }); continue; }
    const at = nowIso();
    const out = applyRun(run, { status: "claimed", runner: rn.id, claimedAt: at, heartbeatAt: at, location: rn.kind === "local" ? "local" : "cloud", host: rn.host, agent: run.agent || rn.agents[0] || "", step: "「" + rn.name + "」已领取", progress: 5 });
    logRun("runner", out, "「" + rn.name + "」领取执行（" + MODE_LABEL[out.mode] + (out.agent ? " · " + out.agent : "") + "）");
    return { run: runView(out), task: getTask(t.id), brief: taskBrief(t) };
  }
  return { run: null };
}
// 执行端回报：ready（工作区就绪）、running（Agent 已启动）、exited（进程退出）、failed、cancelled，以及步骤与进度
export function runUpdate(runId, b = {}, origin = "runner") {
  const run = getRun(runId); if (!run) throw httpError(404, "找不到执行记录 " + runId);
  const f = {}; const at = nowIso();
  const active = RUN_ACTIVE.includes(run.status);
  if (b.exitCode != null && Number.isFinite(Number(b.exitCode))) f.exitCode = Number(b.exitCode);
  // 已结束的执行（取消、回执已到）只补记退出码，迟到的步骤回报不覆盖最终状态
  if (!active) return runView(Object.keys(f).length ? applyRun(run, f) : run);
  for (const k of ["worktree", "branch", "session", "host"]) if (b[k]) f[k] = clip(b[k], 300);
  if (b.step) f.step = clip(b.step);
  if (b.note) f.note = clip(b.note, 500);
  const ak = agentKey(b.agent); if (ak && !NOT_AGENTS.includes(ak) && !run.agent) f.agent = ak;
  const p = pct(b.progress); if (p !== undefined) f.progress = p;
  f.heartbeatAt = at;
  const t = getTask(run.task);
  const toNeedsHuman = (note) => { if (t && t.status === "执行中") moveTask(t, "需介入", null, origin); return note; };
  let msg = "";
  switch (b.status) {
    case "ready": f.status = "ready"; f.step = f.step || "工作区已就绪，等待启动 Agent"; if (run.progress == null || run.progress < 10) f.progress = f.progress ?? 10; msg = "工作区已就绪" + (f.worktree ? "：" + f.worktree : ""); break;
    case "running": f.status = "running"; f.startedAt = run.startedAt || at; f.step = f.step || "Agent 运行中"; if (run.progress == null || run.progress < 15) f.progress = f.progress ?? 15; msg = "Agent 已启动" + (b.agent ? "：" + b.agent : ""); break;
    case "exited": {
      const code = f.exitCode ?? 0;
      f.status = "failed"; f.endedAt = at;
      f.note = f.note || toNeedsHuman(code === 0 ? "Agent 已退出，但没有收到交付回执" : `Agent 异常退出（退出码 ${code}）`);
      f.step = code === 0 ? "已退出，缺少回执" : "异常退出";
      msg = f.note; break;
    }
    case "failed": f.status = "failed"; f.endedAt = at; f.note = toNeedsHuman(f.note || "执行失败"); msg = "执行失败：" + f.note; break;
    case "cancelled": f.status = "cancelled"; f.endedAt = at; f.step = "已取消"; msg = "执行已停止"; break;
  }
  const out = applyRun(run, f);
  if (msg) logRun(origin, out, msg);
  return runView(out);
}

/* ---------------- 任务文档变化 → 收尾执行记录（来源可以是网页、MCP、钩子、对端同步） ---------------- */
function onTaskDoc(e) {
  if (e.coll !== "tasks" || e.origin === "exec") return;
  const act = listRuns({ task: e.id, statuses: RUN_ACTIVE, limit: 20 });
  if (!act.length) return;
  const at = nowIso();
  if (e.op === "delete") { act.forEach((r) => applyRun(r, { status: "cancelled", cancel: true, endedAt: at, note: "任务已删除" })); return; }
  const d = e.data || {};
  if (d.status === "已合并" || d.status === "已放弃") {
    for (const r of act) applyRun(r, d.status === "已合并" && r.status !== "queued" ? { status: "done", progress: 100, endedAt: at, step: "已合并" } : { status: "cancelled", cancel: true, endedAt: at, step: d.status === "已合并" ? "任务已合并" : "任务已放弃" });
    return;
  }
  const rc = d.receipt;
  for (const r of act) {
    if (r.status === "queued") continue;
    const fresh = rc && rc.at && Date.parse(rc.at) >= Date.parse(r.createdAt);
    if (fresh && !r.receipt) applyRun(r, d.status === "需介入" ? { status: "blocked", receipt: true, endedAt: at, step: "回执：阻塞" } : { status: "done", receipt: true, progress: 100, endedAt: at, step: "已交付回执" });
    else if (d.status === "待评审" && !fresh) applyRun(r, { status: "done", progress: 100, endedAt: at, step: "已提交评审" });
  }
}
// 在 Hub 实例创建时调用一次（Cloudflare 每个 Durable Object 实例各自注册到自己的事件总线）
export function wireExec() {
  bus.on("doc", (e) => { try { onTaskDoc(e); } catch (err) { console.error("[exec]", err && err.message); } });
}
