// 任务领域逻辑：与界面里的规则保持一致（状态流、回执解析、任务单生成、指标）
import crypto from "node:crypto";
import { getDoc, setDoc, updateDoc, listDocs } from "#hub/db";
import { config } from "#hub/config";

export const STATUSES = ["待规格", "待执行", "执行中", "需介入", "待评审", "已合并", "已放弃"];
export const OPEN = ["待规格", "待执行", "执行中", "需介入", "待评审"];
export const RISKS = ["L1", "L2", "L3", "L4"];
export const REASONS = ["规格不清", "上下文缺失", "越界改动", "验证不足", "设计问题", "代码质量", "安全隐患", "Agent 能力不足"];
export const TARGETS = ["AGENTS.md", "CLAUDE.md", ".cursor/rules", "评审清单", "验证脚本", "任务单模板"];
export const DEFAULT_AGENTS = ["Claude Code", "Cowork", "Codex", "Cursor", "Copilot", "Kiro", "Gemini CLI"];
// 接入标识（钩子 URL、MCP ?agent=）→ 界面显示名
export const AGENT_NAMES = {
  "claude-code": "Claude Code", cowork: "Cowork", "claude-ai": "Claude", codex: "Codex", cursor: "Cursor",
  copilot: "Copilot", kiro: "Kiro", gemini: "Gemini CLI", git: "git", "task-sh": "task.sh", human: "人工",
};
export const agentName = (key) => AGENT_NAMES[key] || key || "";
export const TASK_ID_RE = /T\d{6}-[a-z0-9]{2,8}/;

const nowIso = () => new Date().toISOString();
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const rid = (n) => crypto.randomBytes(8).toString("base64url").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, n).padEnd(n, "0");
export const lines = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : String(v || "").split(/\n/).map((x) => x.trim()).filter(Boolean));

export function newTaskId() {
  const d = new Date(); const p = (x) => String(x).padStart(2, "0");
  let id;
  do { id = "T" + String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) + "-" + rid(3); } while (getDoc("tasks", id));
  return id;
}
export function newTaskDoc(o = {}) {
  const at = nowIso(); const st = STATUSES.includes(o.status) ? o.status : "待执行";
  return Object.assign({
    title: "", project: "", agent: "", risk: "L2", goal: "", acceptance: [], allow: "", deny: "", budgetMin: 60, spec: "", branch: "", pr: "", session: "",
    cost: null, minutes: null, ciRounds: null, lines: null, reworks: [], history: [{ at, from: "", to: st }], createdAt: at, updatedAt: at, startedAt: st === "执行中" ? at : null, doneAt: null,
  }, o, { status: st });
}

export function getTask(id) { const d = getDoc("tasks", id); return d ? Object.assign({}, d.data, { id }) : null; }
export function allTasks() { return listDocs("tasks").map((d) => Object.assign({}, d.data, { id: d.id })); }
export function allRules() { return listDocs("rules").map((d) => Object.assign({}, d.data, { id: d.id })); }
export function getConfig() {
  const d = getDoc("config", "main");
  return normalizeConfig(d ? d.data : {});
}
export function normalizeConfig(c) {
  const agents = Array.isArray(c && c.agents) ? c.agents.map(String).filter(Boolean) : DEFAULT_AGENTS.slice();
  const L = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const projects = Array.isArray(c && c.projects) ? c.projects.filter((p) => p && p.name).map((p) => ({
    name: String(p.name), path: String(p.path || p.repo || ""), repo: String(p.repoName || ""), stage: String(p.stage || "开发中"), stack: String(p.stack || ""), docs: String(p.docs || ""),
    verify: L(p.verify), invariants: L(p.invariants), forbidden: L(p.forbidden), protect: L(p.protect),
    onboard: p.onboard && typeof p.onboard === "object" ? p.onboard : {}, ruleFiles: p.ruleFiles && typeof p.ruleFiles === "object" ? p.ruleFiles : {},
  })) : [];
  return { agents, projects };
}
export function projByName(name) { return getConfig().projects.find((p) => p.name === name) || null; }
// 通过仓库目录名推断项目（task.sh / 钩子上报的 repo 字段）
export function projByRepo(repo) {
  if (!repo) return null;
  const r = String(repo).toLowerCase();
  const ps = getConfig().projects;
  return ps.find((p) => p.path && p.path.replace(/\/+$/, "").split("/").pop().toLowerCase() === r)
    || ps.find((p) => p.name.toLowerCase() === r) || null;
}
export function ensureAgentListed(display) {
  if (!display) return;
  const d = getDoc("config", "main");
  const cfg = d ? d.data : { agents: DEFAULT_AGENTS.slice(), projects: [] };
  const agents = Array.isArray(cfg.agents) ? cfg.agents : DEFAULT_AGENTS.slice();
  if (!agents.includes(display)) setDoc("config", "main", Object.assign({}, cfg, { agents: agents.concat([display]) }), "hub");
}

export function patchTask(id, patch, origin = "hub") {
  patch.updatedAt = nowIso();
  return updateDoc("tasks", id, patch, origin);
}
export function moveTask(t, to, extra, origin = "hub") {
  const at = nowIso();
  const patch = Object.assign({ status: to, history: (t.history || []).concat([{ at, from: t.status, to, by: origin }]).slice(-40) }, extra || {});
  if (to === "执行中" && !t.startedAt) patch.startedAt = at;
  if (to === "已合并" || to === "已放弃") patch.doneAt = at; else if (t.doneAt) patch.doneAt = null;
  return patchTask(t.id, patch, origin);
}
// 评审语义：合并 / 退回 / 放弃（界面、MCP、task.sh 共用）
export function reviewTask(t, action, { reasons = [], note = "", dropReason = "" } = {}, origin = "hub") {
  const at = nowIso();
  const sel = (reasons || []).filter((r) => typeof r === "string").slice(0, 10);
  if (action === "merge") return moveTask(t, "已合并", { review: { at, firstPass: !(t.reworks || []).length, reasons: sel, note: String(note || "") } }, origin);
  if (action === "rework") return moveTask(t, "执行中", { reworks: (t.reworks || []).concat([{ at, reasons: sel, note: String(note || "") }]).slice(-30) }, origin);
  if (action === "drop") return moveTask(t, "已放弃", { dropReason: String(dropReason || sel[0] || "需求取消"), dropNote: String(note || "") }, origin);
  throw new Error("unknown review action");
}

/* ---------------- 交付回执 ---------------- */
export function parseReceipt(raw) {
  let text = String(raw || "");
  const m = text.match(/```\s*agent-receipt\s*\n([\s\S]*?)```/i);
  if (m) text = m[1];
  const out = {}; let cur = null;
  text.split(/\r?\n/).forEach((line) => {
    const clean = line.replace(/\s+#\s.*$/, "");
    if (!clean.trim()) return;
    const li = clean.match(/^\s*[-*]\s+(.*)$/);
    if (li && cur) { (out[cur] = Array.isArray(out[cur]) ? out[cur] : []).push(li[1].trim()); return; }
    const kv = clean.match(/^\s*([A-Za-z_]+)\s*[:：]\s*(.*)$/);
    if (kv) { cur = kv[1].toLowerCase(); const v = kv[2].trim(); out[cur] = v === "" ? [] : v; }
  });
  if (!out.task && !out.summary && !out.changed) return null;
  const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(/[,，]\s*/).filter(Boolean) : []);
  const verify = list(out.verify).map((s) => {
    const mm = s.match(/^(.*?)\s*[:：]\s*(pass|fail|通过|失败|ok|unknown)\s*$/i);
    return mm ? { cmd: mm[1].trim().replace(/^`|`$/g, ""), result: /pass|通过|ok/i.test(mm[2]) ? "pass" : /fail|失败/i.test(mm[2]) ? "fail" : "unknown" } : { cmd: s, result: "unknown" };
  });
  const st = String(out.status || "").toLowerCase();
  return {
    task: typeof out.task === "string" ? out.task.replace(/[<>]/g, "").trim() : "",
    status: /block|阻塞|失败|fail/.test(st) ? "blocked" : "done",
    summary: typeof out.summary === "string" ? out.summary : "",
    changed: list(out.changed), verify,
    scope: typeof out.scope === "string" ? out.scope : "",
    risks: typeof out.risks === "string" ? out.risks : "",
    session: typeof out.session === "string" ? out.session : "",
    cost: num(out.cost), minutes: num(out.minutes), ciRounds: num(out.ci_rounds), lines: num(out.lines),
  };
}
// 在任意文本里找最后一个回执块（兼容 JSON 转义过的文本，例如会话记录 JSONL）
export function findReceipt(text) {
  const s = String(text || "");
  if (!/agent-receipt/i.test(s)) return null;
  const tryFind = (t) => {
    const all = [...t.matchAll(/```\s*agent-receipt\s*\n[\s\S]*?```/gi)];
    return all.length ? all[all.length - 1][0] : null;
  };
  let blk = tryFind(s);
  if (!blk) {
    const un = s.replace(/\\\\/g, "\u0000").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\u0000/g, "\\");
    blk = tryFind(un);
  }
  if (!blk) return null;
  const r = parseReceipt(blk);
  if (r) r.hash = crypto.createHash("sha1").update(blk).digest("hex").slice(0, 12);
  return r;
}
export function normReceipt(o) {
  if (!o || typeof o !== "object") return null;
  const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? String(v).split(/[,，\n]\s*/).filter(Boolean) : []);
  return {
    task: o.task ? String(o.task) : "", status: /block/i.test(String(o.status || "")) ? "blocked" : "done", summary: String(o.summary || ""), changed: arr(o.changed),
    verify: Array.isArray(o.verify) ? o.verify.map((v) => ({ cmd: String((v && v.cmd) || v || ""), result: ["pass", "fail"].includes(v && v.result) ? v.result : "unknown" })).filter((v) => v.cmd) : [],
    scope: String(o.scope || ""), risks: String(o.risks || ""), session: o.session ? String(o.session) : "",
    cost: num(o.cost), minutes: num(o.minutes), ciRounds: num(o.ci_rounds ?? o.ciRounds), lines: num(o.lines),
  };
}
export function receiptPatch(t, r, by) {
  const patch = { receipt: { summary: r.summary || "", changed: (r.changed || []).slice(0, 200), verify: (r.verify || []).slice(0, 50), scope: r.scope || "", risks: r.risks || "", at: nowIso(), by: by || "", hash: r.hash || "" } };
  if (r.session && !/^unknown$/i.test(r.session) && !t.session) patch.session = r.session;
  if (r.cost != null) patch.cost = r.cost;
  if (r.minutes != null) patch.minutes = r.minutes;
  if (r.ciRounds != null) patch.ciRounds = r.ciRounds;
  if (r.lines != null) patch.lines = r.lines;
  const bad = r.status === "blocked" || (r.verify || []).some((v) => v.result === "fail");
  return { patch, to: bad ? "需介入" : "待评审" };
}
export function scopeOk(s) { return !s || /^(ok|无|none|没有)$/i.test(String(s).trim()); }
// 写入回执并推进状态；同一个回执（hash 相同）重复到达时忽略
export function applyReceipt(t, r, origin = "hub") {
  if (r.hash && t.receipt && t.receipt.hash === r.hash) return { skipped: true, task: t };
  const { patch, to } = receiptPatch(t, r, origin);
  const d = ["待评审", "已合并", "已放弃"].includes(t.status) ? patchTask(t.id, patch, origin) : moveTask(t, to, patch, origin);
  return { skipped: false, to: d.data.status, task: Object.assign({}, d.data, { id: t.id }) };
}

/* ---------------- 任务单 ---------------- */
export const RECEIPT_TEMPLATE = [
  "## 交付回执（每次任务结束时必须输出）",
  "任务结束时，在回复末尾输出下面格式的代码块，字段不要省略；不确定的写 unknown。",
  "如果可以使用 agent-hub 的 MCP 工具，同时调用 submit_receipt 提交同样的内容。",
  "",
  "```agent-receipt",
  "task: <任务编号，如 T260922-a1b>",
  "status: done | blocked",
  "summary: <一句话说明做了什么>",
  "changed:",
  "  - <改动的文件路径>",
  "verify:",
  "  - <执行的验证命令>: pass | fail",
  "scope: ok | <超出任务范围的改动及原因>",
  "risks: <已知风险或未完成事项，没有写 无>",
  "session: <会话链接或编号>",
  "minutes: <大约耗时，分钟>",
  "ci_rounds: <CI 运行轮数>",
  "```"].join("\n");

export function relevantRules(project, rules = allRules()) {
  return rules.filter((r) => r.status !== "已废弃" && (!r.scope || r.scope === "全局" || r.scope === project));
}
export function taskBrief(t) {
  const L = [];
  L.push("# 任务 " + t.id + "：" + (t.title || ""));
  L.push("- 项目：" + (t.project || "未指定") + " ｜ 风险等级：" + (t.risk || "未定") + " ｜ 执行 Agent：" + (t.agent || "未指定"));
  L.push("", "## 目标", t.goal || "（待补充）");
  L.push("", "## 验收标准（每条都要可验证）");
  (t.acceptance || []).length ? t.acceptance.forEach((a) => L.push("- [" + (a.done ? "x" : " ") + "] " + a.text)) : L.push("- [ ] （待补充）");
  L.push("", "## 范围", "- 允许修改：" + (t.allow || "未限定"), "- 禁止修改：" + (t.deny || "无额外限制"));
  if (t.spec) L.push("", "## 规格", t.spec);
  L.push("", "## 预算", "- 时长 ≤ " + (t.budgetMin || 60) + " 分钟；验证最多修 3 轮。超出时停止，并在回执中说明原因。");
  const pj = projByName(t.project);
  if (pj && !(pj.onboard || {}).kit) {
    const inv = lines(pj.invariants).concat(lines(pj.forbidden));
    if (inv.length) { L.push("", "## 项目约束"); inv.forEach((x) => L.push("- " + x)); }
    if (lines(pj.verify).length) { L.push("", "## 验证命令"); lines(pj.verify).forEach((x) => L.push("- `" + x + "`")); }
  }
  if ((t.reworks || []).length) {
    const r = t.reworks[t.reworks.length - 1];
    L.push("", "## 上次评审退回（请先处理）", "- 原因：" + (r.reasons || []).join("、"), r.note ? "- 说明：" + r.note : "");
  }
  L.push("", "## 工作方式", "- 在当前分支和目录中工作，不要切换、合并或删除分支", "- 提交信息末尾带 `Task: " + t.id + "`（git 钩子会自动补）", "- 阶段性进展：`bash scripts/agent/hub.sh progress <0-100> \"<当前步骤>\"`，或 agent-hub MCP 的 report_progress");
  const pend = relevantRules(t.project).filter((r) => r.status === "待写入" || !(pj && (pj.onboard || {}).kit));
  if (pend.length) { L.push("", "## 额外规则（尚未写入规则文件）"); pend.forEach((r) => L.push("- " + r.text)); }
  L.push("", "## 完成后", "按 AGENTS.md 中的“交付回执”格式输出回执，task 填 " + t.id + "；能用 agent-hub MCP 时同时调用 submit_receipt。若没有该格式，使用：", "", RECEIPT_TEMPLATE.split("\n").slice(4).join("\n"));
  return L.filter((x) => x !== undefined).join("\n");
}

/* ---------------- 指标（MCP today / 周报） ---------------- */
function inRange(iso, s, e) { if (!iso) return false; const t = new Date(iso).getTime(); return t >= s.getTime() && t < e.getTime(); }
function lastEntered(t, status) { const h = (t.history || []).filter((x) => x.to === status); return h.length ? h[h.length - 1].at : null; }
export function metrics(tasks, s, e) {
  const created = tasks.filter((t) => inRange(t.createdAt, s, e));
  const finished = tasks.filter((t) => inRange(t.doneAt, s, e) && (t.status === "已合并" || t.status === "已放弃"));
  const merged = finished.filter((t) => t.status === "已合并");
  const dropped = finished.filter((t) => t.status === "已放弃");
  const firstPass = merged.filter((t) => !(t.reworks || []).length);
  const cost = finished.reduce((a, t) => a + (num(t.cost) || 0), 0);
  const reasons = {};
  const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
  tasks.forEach((t) => {
    (t.reworks || []).forEach((r) => { if (inRange(r.at, s, e)) (r.reasons || []).forEach(bump); });
    if (t.review && inRange(t.review.at, s, e)) (t.review.reasons || []).forEach(bump);
    if (t.status === "已放弃" && inRange(t.doneAt, s, e) && t.dropReason) bump(t.dropReason);
  });
  return { created: created.length, finished: finished.length, merged: merged.length, dropped: dropped.length, firstPass: firstPass.length, cost: Math.round(cost * 100) / 100, reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]) };
}
// 执行摘要（task.exec）超过阈值没有心跳：Agent 可能卡住、会话已结束但没交付，或机器已关机
export function stalled(t, now = Date.now()) {
  const e = t.exec;
  if (!e || !["claimed", "ready", "running"].includes(e.status) || !OPEN.includes(t.status)) return false;
  const last = Date.parse(e.heartbeatAt || e.startedAt || e.at) || 0;
  return now - last > config.runStallMinutes * 60000;
}
export const execWhere = (e) => (e ? (e.location === "cloud" ? "云端" : "本机") + (e.runnerName || e.host ? " · " + (e.runnerName || e.host) : "") : "");
export function attention(tasks) {
  const items = [];
  const now = Date.now();
  tasks.forEach((t) => {
    if (t.status === "需介入") items.push({ id: t.id, title: t.title, level: "需介入", since: lastEntered(t, "需介入") || t.updatedAt, agent: t.agent, project: t.project });
    else if (t.status === "待评审") items.push({ id: t.id, title: t.title, level: "待评审", since: lastEntered(t, "待评审") || t.updatedAt, waitMin: Math.round((now - new Date(lastEntered(t, "待评审") || t.updatedAt || t.createdAt)) / 60000), agent: t.agent, project: t.project });
    else if (stalled(t, now)) items.push({ id: t.id, title: t.title, level: "执行停滞", since: t.exec.heartbeatAt || t.exec.at, idleMin: Math.round((now - Date.parse(t.exec.heartbeatAt || t.exec.at)) / 60000), where: execWhere(t.exec), agent: t.agent, project: t.project });
    else if (t.exec && t.exec.status === "queued" && OPEN.includes(t.status) && now - Date.parse(t.exec.at || t.updatedAt) > 30 * 60000) items.push({ id: t.id, title: t.title, level: "派发未领取", since: t.exec.at, agent: t.agent, project: t.project });
    else if (t.status === "执行中" && num(t.budgetMin) && t.startedAt) { const run = (now - new Date(t.startedAt)) / 60000; if (run > num(t.budgetMin)) items.push({ id: t.id, title: t.title, level: "超出时长预算", runMin: Math.round(run), budgetMin: t.budgetMin, agent: t.agent, project: t.project }); }
  });
  const order = { "需介入": 0, "待评审": 1, "执行停滞": 2, "派发未领取": 3, "超出时长预算": 4 };
  return items.sort((a, b) => order[a.level] - order[b.level] || (b.waitMin || 0) - (a.waitMin || 0));
}
