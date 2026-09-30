// 事件接入：把各 Agent 的钩子载荷归一化，关联到任务和会话，并据此推进任务状态
import { addEvent, touchSession, bumpSession, getSession, sessionsForTask, kv } from "#hub/db";
import { config } from "#hub/config";
import { TASK_ID_RE, AGENT_NAMES, agentName, getTask, moveTask, patchTask, findReceipt, applyReceipt, ensureAgentListed, taskBrief } from "./domain.js";

const lc = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const EDIT_TOOLS = /^(edit|write|multiedit|apply_?patch|create|str_?replace(_editor)?|fs_?write|notebookedit|delete|writefile|editfile)$/i;

export function kindOf(event) {
  const e = lc(event);
  if (["sessionstart", "agentspawn", "workspaceopen"].includes(e)) return "session.start";
  if (e === "sessionend") return "session.end";
  if (["userpromptsubmit", "userpromptsubmitted", "beforesubmitprompt", "promptsubmit"].includes(e)) return "prompt";
  if (["pretooluse", "beforeshellexecution", "beforemcpexecution", "beforereadfile", "permissionrequest"].includes(e)) return "tool.pre";
  if (["posttooluse", "aftershellexecution", "aftermcpexecution"].includes(e)) return "tool";
  if (["posttoolusefailure", "erroroccurred", "stopfailure"].includes(e)) return "error";
  if (["afterfileedit", "postfilesave", "postfilecreate", "postfiledelete", "fileedited"].includes(e)) return "edit";
  if (["stop", "agentstop", "notify", "agentturncomplete"].includes(e)) return "stop";
  if (e === "afteragentresponse") return "response";
  if (["posttaskexecution", "taskcompleted"].includes(e)) return "spec.task";
  if (["deny", "guarddeny"].includes(e)) return "deny";
  if (e === "transcript") return "transcript";
  if (["subagentstart", "subagentstop"].includes(e)) return "subagent";
  if (["precompact", "postcompact"].includes(e)) return "compact";
  return "other";
}

function parseMaybe(v) { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } }
function filesFromPatch(cmd) {
  const out = []; const re = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\]+)/g; let m;
  while ((m = re.exec(String(cmd || "")))) out.push(m[1].trim());
  return out;
}
// 从各家载荷里取公共字段
export function extract(agent, p) {
  p = p && typeof p === "object" ? p : {};
  const ti = parseMaybe(p.tool_input ?? p.toolArgs ?? p.tool_args ?? p.input) || {};
  const tool = p.tool_name || p.toolName || p.tool || "";
  const cmd = (ti && (ti.command || ti.cmd)) || p.command || "";
  let files = [];
  const f = (ti && (ti.file_path || ti.path || ti.filePath || ti.target_file)) || p.file_path || p.filePath || "";
  if (f) files.push(String(f));
  if (/apply_?patch/i.test(tool) || /\*\*\* (Update|Add|Delete) File:/.test(cmd)) files = files.concat(filesFromPatch(cmd));
  const text = p.last_assistant_message ?? p["last-assistant-message"] ?? p.assistant_response ?? p.response ?? p.text ?? "";
  return {
    session: String(p.session_id || p.sessionId || p.conversation_id || p["thread-id"] || p.thread_id || p.conversationId || ""),
    cwd: String(p.cwd || (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : "") || ""),
    model: String(p.model || p.model_id || ""),
    tool: String(tool), files: [...new Set(files)], command: typeof cmd === "string" ? cmd : "",
    text: typeof text === "string" ? text : "",
    source: String(p.source || p.reason || p.status || p.stopReason || p.final_status || ""),
    transcript: String(p.transcript_path || p.transcriptPath || ""),
    durationMs: Number(p.duration_ms) || null,
  };
}

export function resolveTask({ hint, branch, cwd, session }) {
  const cands = [];
  if (hint) cands.push(String(hint));
  const b = String(branch || "").match(TASK_ID_RE); if (b) cands.push(b[0]);
  const c = String(cwd || "").match(new RegExp("\\.worktrees/(" + TASK_ID_RE.source + ")")); if (c) cands.push(c[1]);
  const s = getSession(session); if (s && s.task) cands.push(s.task);
  for (const id of cands) { const t = getTask(id); if (t) return t; }
  return null;
}
function repoOf(q, cwd) {
  if (q.repo) return String(q.repo).slice(0, 120);
  const m = String(cwd || "").match(/([^/]+)\.worktrees\//); if (m) return m[1];
  return String(cwd || "").replace(/\/+$/, "").split("/").pop() || "";
}
function summarize(kind, x, extra = "") {
  const short = (s, n = 90) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
  switch (kind) {
    case "session.start": return "会话开始" + (x.source ? "（" + x.source + "）" : "") + (x.model ? " · " + x.model : "");
    case "session.end": return "会话结束" + (x.source ? "（" + x.source + "）" : "");
    case "prompt": return "用户输入";
    case "edit": return "修改 " + (short(x.files.join("、"), 120) || x.tool);
    case "tool": return x.files.length && EDIT_TOOLS.test(x.tool) ? "修改 " + x.files.join("、") : x.command ? "执行 " + short(x.command) : "工具 " + x.tool;
    case "error": return "出错 " + short(x.tool || x.source);
    case "stop": { const t = String(x.text || "").split(/```\s*agent-receipt/i)[0]; return "一轮结束" + (t.trim() ? "：" + short(t, 70) : ""); }
    case "response": return "回复：" + short(x.text, 70);
    case "deny": return "拦截：" + (x.files.join("、") || short(x.command)) + (extra ? "（" + extra + "）" : "");
    case "spec.task": return "Kiro spec 任务完成";
    case "transcript": return "会话记录（用于提取回执）";
    default: return x.tool ? "工具 " + x.tool : kind;
  }
}
function payloadForStore(p, x) {
  if (config.storePayload === "none") return null;
  if (config.storePayload === "full") { const s = JSON.stringify(p); return s.length > 32768 ? { truncated: s.slice(0, 32768) } : p; }
  const o = { tool: x.tool || undefined, files: x.files.length ? x.files : undefined, command: x.command ? x.command.slice(0, 300) : undefined, source: x.source || undefined, model: x.model || undefined };
  return Object.values(o).some((v) => v !== undefined) ? o : null;
}

/**
 * 接收一条 Agent 事件。
 * @param {object} o {agent, event, payload, text, query:{task,branch,repo,cwd}, channel}
 * @returns {{event, task, context}} context 为需要注入给 Agent 的任务单（仅会话开始时）
 */
export function ingest(o) {
  const agent = String(o.agent || "unknown").toLowerCase().slice(0, 40);
  const q = o.query || {};
  const x = extract(agent, o.payload);
  if (q.cwd && !x.cwd) x.cwd = String(q.cwd);
  let kind = o.kind || kindOf(o.event);
  if (kind === "tool" && EDIT_TOOLS.test(x.tool) && x.files.length) kind = "edit";
  // 文件路径显示为仓库内的相对路径
  x.files = x.files.map((f) => { let r = String(f); if (x.cwd && r.startsWith(x.cwd.replace(/\/+$/, "") + "/")) r = r.slice(x.cwd.replace(/\/+$/, "").length + 1); return r.replace(/^.*\.worktrees\/[^/]+\//, ""); });
  const repo = repoOf(q, x.cwd);
  const task = resolveTask({ hint: q.task, branch: q.branch, cwd: x.cwd, session: x.session });
  const display = agentName(agent);
  const at = new Date().toISOString();

  markChannel(agent, o.channel || "hooks");
  if (x.session) {
    const before = getSession(x.session);
    touchSession(x.session, { agent, task: task ? task.id : null, repo, cwd: x.cwd, model: x.model, channel: o.channel || "hooks", at });
    if (task && before && !before.task && (before.cost_usd || before.tokens_in)) recomputeUsage(task.id);
    const d = {};
    if (kind === "tool" || kind === "edit") d.tool_calls = 1;
    if (kind === "edit" || (kind === "tool" && EDIT_TOOLS.test(x.tool))) d.edits = 1;
    if (kind === "deny") d.denies = 1;
    if (kind === "stop") d.turns = 1;
    if (kind === "session.end") d.ended_at = at;
    bumpSession(x.session, d);
  }

  let context = "";
  let t = task;
  if (t && kind === "session.start") {
    if (["待规格", "待执行", "需介入"].includes(t.status)) {
      const d = moveTask(t, "执行中", { agent: t.agent || display, branch: t.branch || q.branch || "", session: t.session || x.session }, agent);
      t = Object.assign({}, d.data, { id: t.id });
    } else if (!t.agent || (!t.branch && q.branch)) {
      patchTask(t.id, { agent: t.agent || display, branch: t.branch || q.branch || "" }, agent);
    }
    if (AGENT_NAMES[agent] && !["git", "task-sh", "human"].includes(agent)) ensureAgentListed(display);
    if (!/^resume$/i.test(x.source)) context = contextFor(t);
  }

  // 回执：从一轮结束的消息、回复、会话记录尾部里找
  let receipt = null;
  const scan = o.text || x.text || (kind === "stop" || kind === "response" || kind === "spec.task" ? JSON.stringify(o.payload || {}) : "");
  if (scan && ["stop", "response", "transcript", "spec.task", "session.end"].includes(kind)) receipt = findReceipt(scan);
  let receiptResult = null;
  if (receipt) {
    const target = (receipt.task && getTask(receipt.task)) || t;
    if (target) {
      receiptResult = applyReceipt(target, receipt, agent);
      t = receiptResult.task;
      if (!receiptResult.skipped) addEvent({ agent, kind: "receipt", raw: o.event || kind, task: target.id, session: x.session, repo, branch: q.branch, summary: "回执：" + (receipt.status === "blocked" ? "阻塞 · " : "") + (receipt.summary || "").slice(0, 120) + " → " + receiptResult.to });
    }
  }

  if (kind === "transcript" && !receiptResult) return { event: null, task: t, context };
  const ev = addEvent({ agent, kind, raw: o.event || "", task: t ? t.id : null, session: x.session, repo, branch: q.branch || "", summary: o.summary || summarize(kind, x, q.reason), data: payloadForStore(o.payload, x) });
  return { event: ev, task: t, context, receipt: receiptResult };
}

export function contextFor(t) {
  const brief = taskBrief(t);
  const head = `你正在执行 agent-hub 任务 ${t.id}（当前状态：${t.status}）。下面是任务单；完成后按“交付回执”格式输出回执，能用 agent-hub MCP 时同时调用 submit_receipt。`;
  const s = head + "\n\n" + brief;
  return s.length > 9000 ? s.slice(0, 9000) + "\n…（任务单过长已截断，完整内容见 specs/" + t.id + ".md）" : s;
}

// 按各 Agent 的协议包装“会话开始注入上下文”的返回值
export function sessionStartResponse(agent, context) {
  if (!context) return { type: "json", body: {} };
  switch (agent) {
    case "cursor": return { type: "json", body: { additional_context: context } };
    case "copilot": return { type: "json", body: { additionalContext: context } };
    case "kiro": return { type: "text", body: context };
    default: return { type: "json", body: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } };
  }
}

// 各接入通道最近一次出现的时间（“接入”页用）
export function markChannel(agent, channel) {
  if (!agent || !channel) return;
  const k = agent + "|" + channel; const t = Date.now();
  const m = kv.get("channels") || {};
  if (t - (Date.parse(m[k] || "") || 0) < 30000) return;
  m[k] = new Date(t).toISOString();
  kv.set("channels", m);
}
export function channels() { return kv.get("channels") || {}; }

// 把任务名下所有会话的成本 / token 汇总回任务（成本换算成元；手工填写过成本的任务不覆盖）
export function recomputeUsage(taskId) {
  const t = getTask(taskId); if (!t) return;
  const ss = sessionsForTask(taskId);
  const u = { sessions: ss.length, costUsd: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, edits: 0, denies: 0, agents: [] };
  const ag = new Set();
  for (const s of ss) { u.costUsd += s.cost_usd || 0; u.tokensIn += s.tokens_in || 0; u.tokensOut += s.tokens_out || 0; u.toolCalls += s.tool_calls || 0; u.edits += s.edits || 0; u.denies += s.denies || 0; if (s.agent) ag.add(s.agent); }
  u.costUsd = Math.round(u.costUsd * 10000) / 10000; u.agents = [...ag];
  const patch = { usage: u };
  if (!t.costManual && u.costUsd > 0) patch.cost = Math.round(u.costUsd * config.usdToCny * 100) / 100;
  patchTask(taskId, patch, "otel");
}
