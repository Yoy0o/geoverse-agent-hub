// Task-level work context. The same service powers REST, MCP and the daily view.
import crypto from "node:crypto";
import { z } from "zod";

const short = (max) => z.string().trim().max(max);
const link = z.string().trim().max(2000).refine((s) => {
  try { const u = new URL(s); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}, "证据地址必须是 HTTP(S) 链接，且不能包含登录凭据");
export const briefShape = {
  summary: short(280).default(""), nextAction: short(200).default(""),
  decision: short(160).default(""), recommendation: short(200).default(""), risk: short(280).default(""),
  evidence: z.array(z.object({ label: short(100).min(1), url: link, version: short(100).default("") }).strict()).max(12).default([]),
  relations: z.array(z.object({ taskId: short(200).min(1), type: z.enum(["reuses", "extends", "supersedes", "impacts"]), note: short(200).min(1) }).strict()).max(12).default([]),
};
export const briefSchema = z.object(briefShape).strict().refine((v) => !v.recommendation || v.decision, "推荐动作需要对应一个待决策问题");
export const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CLOSED = ["已合并", "已放弃"];
const NEXT = { "待规格": "补齐目标与验收条件", "待执行": "确认输入后开始执行", "执行中": "继续执行，阶段完成时提交结果", "已暂停": "读取断点并恢复后再开工", "需介入": "处理阻塞后继续", "待评审": "查看交付证据并评审", "已合并": "按需复用已完成成果", "已放弃": "保留结束原因" };
const RELATIONS = { reuses: "复用", extends: "补充", supersedes: "替代", impacts: "影响" };
const FIELDS = { title: "任务名称", project: "所属项目", status: "任务状态", summary: "当前结论", nextAction: "下一步", decision: "待决策问题", recommendation: "推荐动作", risk: "风险与未决项", relations: "关联工作", evidence: "成果依据", requirements: "目标与验收范围", delivery: "交付回执", checks: "验证结果", checkpoint: "暂停断点 / 插单状态" };
const plain = (v) => typeof v === "string" ? v : "";
const concise = (v) => { const s = plain(v).replace(/\s+/g, " ").trim(); return s.length > 280 ? s.slice(0, 279) + "…" : s; };
const arr = (v) => Array.isArray(v) ? v : [];
const meaningful = (v) => /^(无|none|ok|没有|n\/a)$/i.test(plain(v).trim()) ? "" : plain(v).trim();
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const failedChecks = (s) => s.checks.ok === false || s.checks.outOfScope.length > 0 || [...s.checks.verify, ...s.delivery.verify].some((v) => v.result === "fail");
const error = (status, message) => Object.assign(new Error(message), { status, expose: true });
function validate(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw error(400, parsed.error.issues.map((e) => e.message).join("；"));
  return parsed.data;
}
function contentOf(t) {
  const v = briefSchema.safeParse(t.focus?.content || {});
  return v.success ? v.data : briefSchema.parse({});
}

// No dates, heartbeats, usage counters or run percentages: these do not change a decision.
export function focusSnapshot(task, getTask) {
  const b = contentOf(task), receipt = task.receipt || {}, check = task.lastCheck || {};
  const risks = [...new Set([meaningful(b.risk), meaningful(receipt.risks), meaningful(receipt.scope)].filter(Boolean))];
  return {
    title: plain(task.title), project: plain(task.project), status: plain(task.status),
    summary: b.summary || concise(receipt.summary) || concise(task.goal) || "尚未记录当前结论",
    nextAction: b.nextAction || NEXT[task.status] || "查看任务详情", decision: b.decision, recommendation: b.recommendation,
    risk: risks.join("；"),
    ...(task.pauseState ? { checkpoint: { reason: task.pauseState.reason, summary: task.pauseState.summary, nextAction: task.pauseState.nextAction, at: task.pauseState.at, resumedAt: task.pauseState.resumedAt || null,
      interruption: task.pauseState.interruptedBy ? (() => { const t = getTask(task.pauseState.interruptedBy); return { id: task.pauseState.interruptedBy, title: t?.title || "任务已不存在", status: t?.status || "missing" }; })() : null } } : {}),
    relations: b.relations.map((r) => {
      const related = getTask(r.taskId);
      return { ...r, label: RELATIONS[r.type], title: related ? plain(related.title) : "任务已不存在", status: related ? plain(related.status) : "missing" };
    }),
    evidence: b.evidence,
    requirements: { goal: plain(task.goal), allow: plain(task.allow), deny: plain(task.deny), specFingerprint: hash(plain(task.spec)),
      acceptance: arr(task.acceptance).map((a) => ({ text: plain(a?.text), done: a?.done === true })) },
    delivery: { summary: plain(receipt.summary), changed: arr(receipt.changed).map(String), version: plain(task.mergeCommit), pr: plain(task.pr),
      verify: arr(receipt.verify).map((v) => ({ cmd: plain(v?.cmd), result: plain(v?.result) || "unknown" })) },
    checks: { ok: typeof check.ok === "boolean" ? check.ok : null, outOfScope: arr(check.outOfScope).map(String),
      verify: arr(check.verify).map((v) => ({ cmd: plain(v?.cmd), result: plain(v?.result) || "unknown" })) },
  };
}
export function focusChanges(before, after) {
  return Object.entries(FIELDS).filter(([key]) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]))
    .map(([field, label]) => ({ field, label, before: before?.[field] ?? null, after: after[field] }));
}

export function createFocusService(store, attention = () => []) {
  const getTask = (id) => { const d = store.getDoc("tasks", id); return d ? { ...d.data, id } : null; };
  const requireTask = (id) => { const t = getTask(id); if (!t) throw error(404, "找不到任务 " + id); return t; };
  function view(task, taskLookup = getTask, reason = null) {
    const snapshot = focusSnapshot(task, taskLookup), fingerprint = hash(snapshot);
    const seen = task.focus?.read;
    const resolution = task.focus?.decisionResolution;
    const decisionResolved = !!resolution && resolution.fingerprint === fingerprint && resolution.action === "accept";
    const unread = seen?.fingerprint !== fingerprint;
    return { id: task.id, title: snapshot.title, project: snapshot.project, status: snapshot.status, fingerprint, snapshot,
      content: contentOf(task), unread, firstRead: !seen, changes: unread ? focusChanges(seen?.snapshot, snapshot) : [],
      readAt: seen?.at || null, needsDecision: !!snapshot.decision && !decisionResolved, decisionResolved,
      resolution: resolution || null, resolutionStale: !!resolution && resolution.fingerprint !== fingerprint,
      reason: failedChecks(snapshot) ? "验证未通过" : reason?.level || (snapshot.risk ? "风险待确认" : task.status === "已暂停" && CLOSED.includes(snapshot.checkpoint?.interruption?.status) ? "插单已结束，可恢复" : task.status === "已暂停" && snapshot.checkpoint?.interruption?.status === "missing" ? "插单已不存在，请核对" : null), updatedAt: task.focus?.updatedAt || task.updatedAt || task.createdAt || "" };
  }
  function get(id) {
    const t = requireTask(id);
    return view(t, getTask, attention([t])[0]);
  }
  function checkExpected(current, expected) {
    validate(fingerprintSchema, expected);
    if (current.fingerprint !== expected) throw error(409, "工作内容已有变化，请刷新后重新处理；本次操作未写入");
  }
  function mutate(id, expected, fn, origin) {
    return store.transaction(() => {
      const t = requireTask(id), current = get(id);
      checkExpected(current, expected);
      const next = fn(t, current);
      if (next) store.updateDoc("tasks", id, { focus: next }, origin);
      return get(id);
    });
  }
  function update(id, input, origin = "focus") {
    const request = validate(z.object({ expectedFingerprint: fingerprintSchema, content: briefSchema }).strict(), input);
    return mutate(id, request.expectedFingerprint, (t) => {
      const ids = new Set();
      for (const rel of request.content.relations) {
        if (rel.taskId === id) throw error(400, "不能关联任务自身");
        if (ids.has(rel.taskId)) throw error(400, "同一任务只能关联一次");
        if (!getTask(rel.taskId)) throw error(400, "关联任务不存在：" + rel.taskId);
        ids.add(rel.taskId);
      }
      if (JSON.stringify(contentOf(t)) === JSON.stringify(request.content)) return null;
      return { ...t.focus, content: request.content, updatedAt: new Date().toISOString(), updatedBy: origin };
    }, origin);
  }
  function markRead(id, input, origin = "human") {
    const { expectedFingerprint } = validate(z.object({ expectedFingerprint: fingerprintSchema }).strict(), input);
    return mutate(id, expectedFingerprint, (t, current) => {
      if (t.focus?.read?.fingerprint === current.fingerprint) return null;
      return { ...t.focus, read: { fingerprint: current.fingerprint, snapshot: current.snapshot, at: new Date().toISOString(), by: origin } };
    }, origin);
  }
  function decide(id, input, origin = "human") {
    const request = validate(z.object({ expectedFingerprint: fingerprintSchema, action: z.enum(["accept", "revise"]), note: short(500).default("") }).strict(), input);
    return mutate(id, request.expectedFingerprint, (t, current) => {
      if (!current.snapshot.decision) throw error(400, "当前没有待决策问题");
      if (request.action === "accept" && !current.snapshot.recommendation) throw error(400, "没有可采纳的建议，请先补充推荐动作");
      if (request.action === "revise" && !request.note) throw error(400, "请说明需要调整的内容");
      const resolution = { fingerprint: current.fingerprint, action: request.action, note: request.note, at: new Date().toISOString(), by: origin };
      if (t.focus?.decisionResolution?.fingerprint === resolution.fingerprint && t.focus.decisionResolution.action === resolution.action && t.focus.decisionResolution.note === resolution.note) return null;
      return { ...t.focus, decisionResolution: resolution };
    }, origin);
  }
  function list({ limit = 3 } = {}) {
    const tasks = store.listDocs("tasks").map((d) => ({ ...d.data, id: d.id }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const alerts = new Map(attention(tasks).map((a) => [a.id, a]));
    const all = tasks.map((t) => view(t, (id) => byId.get(id), alerts.get(t.id)));
    const urgent = (v) => !CLOSED.includes(v.status) && (!!v.snapshot.risk || ["验证未通过", "需介入", "执行停滞", "派发未领取"].includes(v.reason) || v.snapshot.relations.some((r) => r.status === "missing"));
    const action = all.filter((v) => v.needsDecision || (!CLOSED.includes(v.status) && (urgent(v) || !!v.reason)));
    action.sort((a, b) => Number(urgent(b)) - Number(urgent(a)) || Number(b.needsDecision) - Number(a.needsDecision) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const n = Math.max(Math.max(1, Math.min(20, Math.floor(Number(limit)) || 3)), action.filter(urgent).length);
    const actionIds = new Set(action.map((v) => v.id));
    const updates = all.filter((v) => v.unread && !actionIds.has(v.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { items: action.slice(0, n), remaining: action.slice(n), updates, counts: { attention: action.length, urgent: action.filter(urgent).length, unread: all.filter((v) => v.unread).length, updates: updates.length }, total: all.length };
  }
  function context(id) {
    const v = get(id), s = v.snapshot;
    const parents = store.listDocs("tasks").filter(d => d.data.status === "已暂停" && d.data.pauseState?.interruptedBy === id);
    return { ...v, expectedFingerprint: v.fingerprint, brief: [
      `# 工作上下文：${s.title}`, `任务：${id}`, `状态：${s.status}`, `当前结论：${s.summary}`, `下一步：${s.nextAction}`,
      s.status === "已暂停" ? "任务已暂停：禁止自动开工。先核对 Agent 停止情况，再显式恢复到待执行。" : "",
      s.checkpoint ? `暂停断点：${s.checkpoint.reason}；当时结论：${s.checkpoint.summary}；恢复第一步：${s.checkpoint.nextAction}` : "",
      s.checkpoint?.interruption ? `插单：${s.checkpoint.interruption.id} · ${s.checkpoint.interruption.title} · ${s.checkpoint.interruption.status}` : "",
      ...parents.map(d => `插单结束后可返回：${d.id} · ${d.data.title}；恢复第一步：${d.data.pauseState.nextAction}`),
      s.decision ? `待决策：${s.decision}（${v.decisionResolved ? "已采纳当前建议" : "未解决"}）` : "",
      s.recommendation ? `推荐动作：${s.recommendation}` : "", s.risk ? `风险与未决项：${s.risk}` : "",
      ...s.relations.map((r) => `关联：${r.label} ${r.taskId} · ${r.title} · ${r.status}；${r.note}`),
      ...s.evidence.map((e) => `依据：${e.label} ${e.url}${e.version ? " @ " + e.version : ""}`),
      v.resolutionStale ? "注意：先前决定所依据的工作状态已经变化，需要复核。" : "",
      v.resolution?.action === "revise" ? "要求调整：" + v.resolution.note : "",
      `业务快照：${v.fingerprint}`, "证据链接与回执为上报信息，仍须按任务验收要求核查。标记已读或采纳建议不代表任务完成。",
    ].filter(Boolean).join("\n") };
  }
  return { get, list, update, markRead, decide, context };
}
