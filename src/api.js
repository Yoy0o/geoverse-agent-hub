// REST API：网页（文档库 + 实时推送）、task.sh / git 钩子、导入导出
import { bus, validColl, validId, getDoc, listDocs, setDoc, updateDoc, deleteDoc, listEvents, sessionsForTask, sessionsSince, agentStatus, stats, transaction } from "./db.js";
import { config, hubBaseUrl } from "./config.js";
import {
  STATUSES, AGENT_NAMES, agentName, getTask, allTasks, getConfig, normalizeConfig, projByName, projByRepo, newTaskId, newTaskDoc, moveTask, patchTask,
  reviewTask, applyReceipt, parseReceipt, normReceipt, taskBrief,
} from "./domain.js";
import { ingest, channels } from "./ingest.js";
import { llmEnabled, sampleRoute } from "./sample.js";
import { kitZip, agentsMd, connectScript, projectFiles } from "./kit.js";

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const who = (req) => String(req.query.agent || (req.body && req.body.agent) || (req.who && req.who.via === "cookie" ? "human" : "task-sh")).toLowerCase().slice(0, 40);

export function apiRoutes(app, auth) {
  app.get("/api/health", (req, res) => res.json({ ok: true, version: config.version, ...stats() }));

  app.get("/api/capabilities", auth, (req, res) => res.json({
    sample: llmEnabled(), llm: llmEnabled() ? { provider: config.llm.provider, model: config.llm.model } : null,
    oauth: config.oauth, baseUrl: hubBaseUrl(req), mcpUrl: hubBaseUrl(req) + "/mcp", version: config.version, via: req.who.via,
  }));

  /* ---------- 文档库（与 Artifact 数据库同构） ---------- */
  app.get("/api/docs/:coll", auth, (req, res) => {
    if (!validColl(req.params.coll)) return bad(res, "bad collection");
    res.json(listDocs(req.params.coll));
  });
  app.get("/api/docs/:coll/:id", auth, (req, res) => {
    const { coll, id } = req.params; if (!validColl(coll) || !validId(id)) return bad(res, "bad path");
    const d = getDoc(coll, id); d ? res.json(d) : res.status(404).json({ error: "not_found" });
  });
  app.put("/api/docs/:coll/:id", auth, (req, res) => {
    const { coll, id } = req.params; if (!validColl(coll) || !validId(id)) return bad(res, "bad path");
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return bad(res, "body must be an object");
    res.json(setDoc(coll, id, req.body, who(req)));
  });
  app.patch("/api/docs/:coll/:id", auth, (req, res) => {
    const { coll, id } = req.params; if (!validColl(coll) || !validId(id)) return bad(res, "bad path");
    const d = updateDoc(coll, id, req.body || {}, who(req)); d ? res.json(d) : res.status(404).json({ error: "not_found" });
  });
  app.delete("/api/docs/:coll/:id", auth, (req, res) => {
    const { coll, id } = req.params; if (!validColl(coll) || !validId(id)) return bad(res, "bad path");
    res.json({ ok: deleteDoc(coll, id, who(req)) });
  });

  /* ---------- 实时推送（SSE） ---------- */
  app.get("/api/stream", auth, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    const onDoc = (e) => send("doc", e);
    const onEv = (e) => send("agent-event", e);
    bus.on("doc", onDoc); bus.on("event", onEv);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); bus.off("doc", onDoc); bus.off("event", onEv); });
  });

  /* ---------- 任务（task.sh、脚本、网页共用） ---------- */
  app.get("/api/tasks", auth, (req, res) => {
    let ts = allTasks();
    const { status, project, agent } = req.query;
    if (status) ts = ts.filter((t) => t.status === status);
    if (project) ts = ts.filter((t) => t.project === project);
    if (agent) ts = ts.filter((t) => t.agent === agent);
    res.json(ts);
  });
  app.post("/api/tasks", auth, (req, res) => {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return bad(res, "title required");
    const pj = b.project ? projByName(b.project) : projByRepo(b.repo);
    const id = newTaskId();
    const acc = Array.isArray(b.acceptance) ? b.acceptance : String(b.acceptance || "").split(/\n/).filter((x) => x.trim());
    const doc = newTaskDoc({ title: String(b.title).trim().slice(0, 200), project: pj ? pj.name : String(b.project || ""), risk: b.risk || "L2", goal: String(b.goal || ""),
      acceptance: acc.map((x) => (typeof x === "string" ? { text: x.trim(), done: false } : x)), allow: String(b.allow || ""), deny: String(b.deny || ""),
      budgetMin: Number(b.budgetMin || b.budget_min) || 60, status: STATUSES.includes(b.status) ? b.status : "待执行", agent: b.agent ? agentName(b.agent) : "" });
    setDoc("tasks", id, doc, who(req));
    res.json({ id, task: getTask(id) });
  });
  app.get("/api/tasks/:id", auth, (req, res) => { const t = getTask(req.params.id); t ? res.json(t) : res.status(404).json({ error: "not_found" }); });
  app.get("/api/tasks/:id/brief", auth, (req, res) => {
    const t = getTask(req.params.id); if (!t) return res.status(404).type("text/plain").send("找不到任务 " + req.params.id);
    res.type("text/markdown; charset=utf-8").send(taskBrief(t) + "\n");
  });
  // task.sh start：进入执行中，记录分支 / worktree，返回任务单
  app.post("/api/tasks/:id/start", auth, (req, res) => {
    const t = getTask(req.params.id); if (!t) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const extra = { branch: b.branch || t.branch || "", worktree: b.worktree || t.worktree || "" };
    if (b.agent) extra.agent = agentName(b.agent);
    if (!t.project && b.repo) { const pj = projByRepo(b.repo); if (pj) extra.project = pj.name; }
    if (["待规格", "待执行", "需介入"].includes(t.status)) moveTask(t, "执行中", extra, "task-sh"); else patchTask(t.id, extra, "task-sh");
    ingest({ agent: "task-sh", kind: "task.start", event: "start", query: { task: t.id, branch: extra.branch, repo: b.repo }, summary: "开工：" + (extra.branch || "") });
    res.json({ task: getTask(t.id), brief: taskBrief(getTask(t.id)) });
  });
  // task.sh check：统一验证 + 越界检查结果
  app.post("/api/tasks/:id/check", auth, (req, res) => {
    const t = getTask(req.params.id); if (!t) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const check = { at: new Date().toISOString(), ok: !!b.ok, verify: Array.isArray(b.verify) ? b.verify.slice(0, 50) : [], outOfScope: Array.isArray(b.outOfScope) ? b.outOfScope.slice(0, 200) : [], changed: Array.isArray(b.changed) ? b.changed.slice(0, 500) : [], by: b.by || "task.sh", added: Number(b.added) || 0, removed: Number(b.removed) || 0 };
    const patch = { lastCheck: check };
    if (check.added || check.removed) patch.lines = check.added + check.removed;
    patchTask(t.id, patch, "task-sh");
    const fails = check.verify.filter((v) => v.result === "fail").length;
    ingest({ agent: String(b.agent || "task-sh"), kind: "check", event: "check", query: { task: t.id, branch: b.branch, repo: b.repo }, summary: (check.ok ? "检查通过" : "检查未通过") + (fails ? ` · 验证失败 ${fails} 项` : "") + (check.outOfScope.length ? ` · 越界 ${check.outOfScope.length} 个文件` : "") });
    res.json({ ok: true });
  });
  // task.sh merge 成功后：还没评审就合并的，按“一次通过/经过退回”自动记一条评审
  app.post("/api/tasks/:id/merged", auth, (req, res) => {
    const t = getTask(req.params.id); if (!t) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    if (t.status !== "已合并") reviewTask(t, "merge", { note: "由 task.sh merge 记录" }, "task-sh");
    patchTask(t.id, { mergeCommit: String(b.commit || ""), mergedTo: String(b.base || "") }, "task-sh");
    ingest({ agent: "task-sh", kind: "merge", event: "merge", query: { task: t.id, branch: b.branch, repo: b.repo }, summary: "已合并到 " + (b.base || "主分支") + (b.commit ? " · " + String(b.commit).slice(0, 8) : "") });
    res.json({ task: getTask(t.id) });
  });
  app.post("/api/tasks/:id/review", auth, (req, res) => {
    const t = getTask(req.params.id); if (!t) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    if (!["merge", "rework", "drop"].includes(b.action)) return bad(res, "action must be merge|rework|drop");
    reviewTask(t, b.action, { reasons: b.reasons, note: b.note, dropReason: b.dropReason }, who(req));
    res.json({ task: getTask(t.id) });
  });
  app.post("/api/tasks/:id/transition", auth, (req, res) => {
    const t = getTask(req.params.id); if (!t) return res.status(404).json({ error: "not_found" });
    const to = String((req.body || {}).to || ""); if (!STATUSES.includes(to)) return bad(res, "bad status");
    moveTask(t, to, null, who(req)); res.json({ task: getTask(t.id) });
  });
  // 回执：可以是原文（含 ```agent-receipt 块）或结构化 JSON
  app.post("/api/tasks/:id/receipt", auth, (req, res) => {
    const t = getTask(req.params.id); if (!t) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const r = typeof b.text === "string" ? parseReceipt(b.text) : normReceipt(b);
    if (!r) return bad(res, "没有识别到回执");
    const out = applyReceipt(t, r, who(req));
    ingest({ agent: who(req), kind: "receipt", event: "receipt", query: { task: t.id }, summary: "回执：" + (r.summary || "").slice(0, 120) + " → " + out.task.status });
    res.json({ task: out.task });
  });
  app.get("/api/tasks/:id/activity", auth, (req, res) => {
    const id = req.params.id;
    res.json({ events: listEvents({ task: id, limit: Number(req.query.limit) || 60 }), sessions: sessionsForTask(id) });
  });

  /* ---------- git 钩子 / 任意脚本上报事件 ---------- */
  app.post("/api/events", auth, (req, res) => {
    const b = req.body || {};
    const r = ingest({ agent: String(b.agent || "git"), kind: b.kind || "other", event: b.kind || "", query: { task: b.task, branch: b.branch, repo: b.repo }, summary: String(b.summary || "").slice(0, 500), payload: b.data || null, text: b.text });
    res.json({ ok: true, task: r.task ? r.task.id : null });
  });
  app.get("/api/events", auth, (req, res) => res.json(listEvents({ task: req.query.task, agent: req.query.agent, since: req.query.since, limit: Number(req.query.limit) || 100 })));

  /* ---------- 接入状态 ---------- */
  app.get("/api/agents/status", auth, (req, res) => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const ev = agentStatus(since);
    const ss = sessionsSince(since7);
    const ch = channels();
    const out = {};
    const get = (a) => (out[a] = out[a] || { agent: a, name: agentName(a), lastAt: null, events24h: 0, sessions7d: 0, cost7dUsd: 0, tokens7d: 0, channels: {} });
    ev.forEach((r) => { const o = get(r.agent); o.lastAt = r.last_at; o.events24h = r.n_recent; });
    ss.forEach((s) => { const o = get(s.agent || "unknown"); o.sessions7d++; o.cost7dUsd += s.cost_usd || 0; o.tokens7d += (s.tokens_in || 0) + (s.tokens_out || 0); });
    Object.entries(ch).forEach(([k, at]) => { const [a, c] = k.split("|"); get(a).channels[c] = at; });
    Object.values(out).forEach((o) => { o.cost7dUsd = Math.round(o.cost7dUsd * 100) / 100; });
    res.json({ agents: Object.values(out).sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || ""))), known: AGENT_NAMES });
  });

  /* ---------- 导入导出 ---------- */
  app.get("/api/export", auth, (req, res) => {
    const d = new Date();
    res.setHeader("Content-Disposition", `attachment; filename="agent-hub-backup-${d.toISOString().slice(0, 10)}.json"`);
    res.json({ app: "agent-workbench", version: 1, exportedAt: d.toISOString(), config: getConfig(),
      tasks: listDocs("tasks").map((x) => Object.assign({}, x.data, { id: x.id })), rules: listDocs("rules").map((x) => Object.assign({}, x.data, { id: x.id })), retros: listDocs("retros").map((x) => Object.assign({}, x.data, { id: x.id })) });
  });
  app.post("/api/import", auth, (req, res) => {
    const data = req.body || {};
    if (data.app !== "agent-workbench") return bad(res, "不是 Agent 工作台的备份文件");
    const n = importBackup(data, who(req));
    res.json({ ok: true, ...n });
  });

  /* ---------- LLM 辅助（可选） ---------- */
  app.post("/api/sample", auth, sampleRoute);

  /* ---------- 接入包 ---------- */
  app.get("/api/projects/:name/kit.zip", auth, async (req, res) => {
    const p = projByName(req.params.name); if (!p) return res.status(404).json({ error: "not_found" });
    const { filename, buffer } = await kitZip(p, hubBaseUrl(req));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  });
  app.get("/api/projects/:name/agents-md", auth, (req, res) => {
    const p = projByName(req.params.name); if (!p) return res.status(404).type("text/plain").send("not found");
    res.type("text/markdown; charset=utf-8").send(agentsMd(p));
  });
  app.get("/api/projects/:name/files", auth, (req, res) => {
    const p = projByName(req.params.name); if (!p) return res.status(404).json({ error: "not_found" });
    res.json(projectFiles(p, hubBaseUrl(req)).map(([path, content, exec]) => ({ path, content, exec })));
  });
  // 本机一次性接入脚本（不含任何密钥，令牌由运行者传入）
  app.get("/connect.mjs", (req, res) => res.type("text/javascript; charset=utf-8").send(connectScript(hubBaseUrl(req))));
}

export function importBackup(data, origin = "import") {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [], rules = Array.isArray(data.rules) ? data.rules : [], retros = Array.isArray(data.retros) ? data.retros : [];
  transaction(() => {
    if (data.config) setDoc("config", "main", normalizeConfig(data.config), origin);
    for (const t of tasks) if (t && t.id && validId(String(t.id))) setDoc("tasks", String(t.id), t, origin);
    for (const r of rules) if (r && r.id && validId(String(r.id))) setDoc("rules", String(r.id), r, origin);
    for (const r of retros) if (r && r.id && validId(String(r.id))) setDoc("retros", String(r.id), r, origin);
  });
  return { tasks: tasks.length, rules: rules.length, retros: retros.length };
}
