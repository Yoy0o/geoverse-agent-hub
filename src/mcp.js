// MCP 服务（Streamable HTTP，无状态）：任何支持 MCP 的 Agent / Claude 客户端都能读任务单、交回执、查今日待办
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { setDoc, updateDoc, addEvent, sessionsForTask } from "./db.js";
import {
  STATUSES, OPEN, RISKS, REASONS, TARGETS, agentName, getTask, allTasks, allRules, getConfig, projByName, newTaskId, newTaskDoc,
  moveTask, patchTask, reviewTask, applyReceipt, normReceipt, taskBrief, relevantRules, attention, metrics,
} from "./domain.js";
import { markChannel } from "./ingest.js";
import { config } from "./config.js";

const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const err = (s) => ({ content: [{ type: "text", text: String(s) }], isError: true });
const line = (t) => `${t.id} · ${t.status} · ${t.risk || "-"} · ${t.project || "未指定项目"} · ${t.agent || "未指定 Agent"} · ${t.title || "(未命名)"}`;

function build(agent) {
  const server = new McpServer({ name: "agent-hub", version: config.version }, {
    instructions: "agent-hub 是研发任务工作台。执行任务时：开始先调用 get_task 读取任务单（任务编号在分支名 agent/<编号>-… 或 specs/<编号>.md 里），按验收标准和允许修改的范围工作；结束时调用 submit_receipt 提交交付回执。人问“今天要处理什么”时调用 today。",
  });
  const log = (tool, taskId, summary) => {
    markChannel(agent, "mcp");
    addEvent({ agent, kind: "mcp", raw: tool, task: taskId || null, summary: summary || "MCP " + tool });
  };

  server.registerTool("today", {
    title: "今日待办", description: "需要人处理的任务（需介入、待评审、超预算）、待写入规则数，以及近 7 天指标。",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => {
    const ts = allTasks(); const now = new Date();
    const m = metrics(ts, new Date(now - 7 * 86400000), new Date(now.getTime() + 1));
    log("today");
    return json({ attention: attention(ts), pendingRules: allRules().filter((r) => r.status === "待写入").length, open: ts.filter((t) => OPEN.includes(t.status)).length, last7d: m });
  });

  server.registerTool("list_tasks", {
    title: "列出任务", description: "按状态、项目、Agent 筛选任务。默认列出进行中的任务。",
    inputSchema: {
      status: z.enum(STATUSES).optional().describe("只看某个状态"),
      project: z.string().optional(), agent: z.string().optional(),
      include_closed: z.boolean().optional().describe("是否包含已合并 / 已放弃"),
      limit: z.number().int().min(1).max(200).optional(),
    }, annotations: { readOnlyHint: true },
  }, async (a) => {
    let ts = allTasks();
    if (a.status) ts = ts.filter((t) => t.status === a.status); else if (!a.include_closed) ts = ts.filter((t) => OPEN.includes(t.status));
    if (a.project) ts = ts.filter((t) => t.project === a.project);
    if (a.agent) ts = ts.filter((t) => (t.agent || "").toLowerCase().includes(a.agent.toLowerCase()));
    ts.sort((x, y) => String(y.updatedAt || "").localeCompare(String(x.updatedAt || "")));
    log("list_tasks");
    return text(ts.slice(0, a.limit || 50).map(line).join("\n") || "没有符合条件的任务");
  });

  server.registerTool("get_task", {
    title: "读取任务单", description: "读取任务的完整任务单（目标、验收标准、范围、预算、规则、回执格式）和当前状态、回执、评审记录。",
    inputSchema: { id: z.string().describe("任务编号，如 T260922-a1b") }, annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const t = getTask(id); if (!t) return err("找不到任务 " + id);
    log("get_task", id, "读取任务单");
    const extra = { status: t.status, branch: t.branch, receipt: t.receipt || null, reworks: t.reworks || [], lastCheck: t.lastCheck || null, usage: t.usage || null };
    return text(taskBrief(t) + "\n\n---\n当前状态（JSON）：\n" + JSON.stringify(extra, null, 2));
  });

  server.registerTool("create_task", {
    title: "新建任务", description: "在工作台新建任务。默认状态“待执行”。",
    inputSchema: {
      title: z.string().min(1), project: z.string().optional(), risk: z.enum(RISKS).optional(), goal: z.string().optional(),
      acceptance: z.array(z.string()).optional().describe("验收标准，每条尽量可验证"),
      allow: z.string().optional().describe("允许修改的路径，如 src/order/**"), deny: z.string().optional(),
      budget_min: z.number().optional(), status: z.enum(["待规格", "待执行"]).optional(), agent: z.string().optional(),
    },
  }, async (a) => {
    const id = newTaskId();
    const doc = newTaskDoc({ title: a.title, project: a.project || "", risk: a.risk || "L2", goal: a.goal || "", acceptance: (a.acceptance || []).map((x) => ({ text: x, done: false })), allow: a.allow || "", deny: a.deny || "", budgetMin: a.budget_min || 60, status: a.status || "待执行", agent: a.agent || "" });
    setDoc("tasks", id, doc, agent);
    log("create_task", id, "新建任务 " + a.title);
    return text(`已创建 ${id}\n开工：bash scripts/agent/task.sh start ${id} <简述>`);
  });

  server.registerTool("update_task", {
    title: "更新任务字段", description: "更新任务的目标、验收标准、范围、链接、用量等字段（不改状态；改状态用 move_task）。",
    inputSchema: {
      id: z.string(), title: z.string().optional(), goal: z.string().optional(), acceptance: z.array(z.string()).optional(),
      allow: z.string().optional(), deny: z.string().optional(), budget_min: z.number().optional(), spec: z.string().optional(),
      pr: z.string().optional(), branch: z.string().optional(), session: z.string().optional(), project: z.string().optional(),
      agent: z.string().optional(), risk: z.enum(RISKS).optional(), cost: z.number().optional().describe("成本（元）"), minutes: z.number().optional(), lines: z.number().optional(),
    },
  }, async (a) => {
    const t = getTask(a.id); if (!t) return err("找不到任务 " + a.id);
    const p = {};
    for (const k of ["title", "goal", "allow", "deny", "spec", "pr", "branch", "session", "project", "agent", "risk", "minutes", "lines"]) if (a[k] !== undefined) p[k] = a[k];
    if (a.acceptance) p.acceptance = a.acceptance.map((x) => ({ text: x, done: false }));
    if (a.budget_min !== undefined) p.budgetMin = a.budget_min;
    if (a.cost !== undefined) { p.cost = a.cost; p.costManual = true; }
    patchTask(a.id, p, agent);
    log("update_task", a.id, "更新 " + Object.keys(p).join("、"));
    return text("已更新 " + a.id);
  });

  server.registerTool("start_task", {
    title: "开始执行", description: "把任务标记为执行中并返回任务单。Agent 开工时调用。",
    inputSchema: { id: z.string(), branch: z.string().optional(), session: z.string().optional() },
  }, async (a) => {
    const t = getTask(a.id); if (!t) return err("找不到任务 " + a.id);
    const extra = { agent: t.agent || agentName(agent), branch: t.branch || a.branch || "", session: t.session || a.session || "" };
    if (["待规格", "待执行", "需介入"].includes(t.status)) moveTask(t, "执行中", extra, agent); else patchTask(t.id, extra, agent);
    log("start_task", a.id, "开始执行");
    return text(taskBrief(getTask(a.id)));
  });

  server.registerTool("submit_receipt", {
    title: "提交交付回执", description: "任务结束时提交回执。status=blocked 或有验证失败时任务进入“需介入”，否则进入“待评审”。",
    inputSchema: {
      task: z.string().describe("任务编号"), status: z.enum(["done", "blocked"]), summary: z.string(),
      changed: z.array(z.string()).optional(), verify: z.array(z.object({ cmd: z.string(), result: z.enum(["pass", "fail", "unknown"]) })).optional(),
      scope: z.string().optional().describe("ok，或超出范围的改动及原因"), risks: z.string().optional(), session: z.string().optional(),
      minutes: z.number().optional(), ci_rounds: z.number().optional(),
    },
  }, async (a) => {
    const t = getTask(a.task); if (!t) return err("找不到任务 " + a.task);
    const r = normReceipt(a);
    const res = applyReceipt(t, r, agent);
    log("submit_receipt", t.id, "回执：" + (a.summary || "").slice(0, 100) + " → " + (res.to || res.task.status));
    return text(`回执已写入 ${t.id}，当前状态：${res.task.status}`);
  });

  server.registerTool("move_task", {
    title: "推进任务状态", description: "人工评审用：merge=评审通过并合并，rework=退回修改（需给原因），drop=放弃；也可以直接设为某个状态。",
    inputSchema: {
      id: z.string(), action: z.enum(["merge", "rework", "drop", "set"]),
      to: z.enum(STATUSES).optional().describe("action=set 时的目标状态"),
      reasons: z.array(z.enum(REASONS)).optional(), note: z.string().optional(), drop_reason: z.string().optional(),
    },
  }, async (a) => {
    const t = getTask(a.id); if (!t) return err("找不到任务 " + a.id);
    if (a.action === "rework" && !(a.reasons || []).length) return err("退回需要至少一个原因：" + REASONS.join("、"));
    if (a.action === "set") { if (!a.to) return err("缺少 to"); moveTask(t, a.to, null, agent); }
    else reviewTask(t, a.action, { reasons: a.reasons, note: a.note, dropReason: a.drop_reason }, agent);
    const nt = getTask(a.id);
    log("move_task", a.id, `${t.status} → ${nt.status}`);
    return text(`${a.id}：${t.status} → ${nt.status}`);
  });

  server.registerTool("list_rules", {
    title: "规则库", description: "列出规则（默认列出适用于某项目、未废弃的规则）。", inputSchema: { project: z.string().optional(), status: z.enum(["待写入", "已写入", "已废弃"]).optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    let rs = a.project ? relevantRules(a.project) : allRules().filter((r) => r.status !== "已废弃");
    if (a.status) rs = allRules().filter((r) => r.status === a.status && (!a.project || !r.scope || r.scope === "全局" || r.scope === a.project));
    log("list_rules");
    return text(rs.map((r) => `${r.id} · ${r.status} · ${r.scope || "全局"} · ${r.target || "AGENTS.md"} · ${r.text}`).join("\n") || "没有规则");
  });

  server.registerTool("add_rule", {
    title: "新增规则", description: "把反复出现的问题沉淀为一条规则（状态“待写入”）。",
    inputSchema: { text: z.string().min(4), target: z.enum(TARGETS).optional(), scope: z.string().optional().describe("全局 或 项目名"), source_task: z.string().optional() },
  }, async (a) => {
    const id = "R-" + Math.random().toString(36).slice(2, 7);
    setDoc("rules", id, { text: a.text.slice(0, 1000), target: a.target || "AGENTS.md", scope: a.scope || "全局", status: "待写入", hits: 1, sourceTask: a.source_task || "", createdAt: new Date().toISOString() }, agent);
    log("add_rule", a.source_task, "新增规则 " + a.text.slice(0, 60));
    return text("已加入规则库：" + id);
  });

  server.registerTool("get_project", {
    title: "项目档案", description: "读取项目档案：技术栈、统一验证命令、不可破坏的约束、禁区、受保护路径。", inputSchema: { name: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    log("get_project");
    if (!a.name) return text(getConfig().projects.map((p) => `${p.name} · ${p.stage} · ${p.stack}`).join("\n") || "还没有项目");
    const p = projByName(a.name); return p ? json(p) : err("找不到项目 " + a.name);
  });

  server.registerTool("log_note", {
    title: "记录进展", description: "在任务活动里记一条进展或决策（例如：为什么选择某个方案、发现的风险）。",
    inputSchema: { task: z.string(), note: z.string().min(1) },
  }, async (a) => {
    const t = getTask(a.task); if (!t) return err("找不到任务 " + a.task);
    markChannel(agent, "mcp");
    addEvent({ agent, kind: "note", raw: "log_note", task: t.id, summary: a.note.slice(0, 500) });
    return text("已记录");
  });

  server.registerTool("task_usage", {
    title: "任务用量", description: "任务名下各 Agent 会话的成本、token、工具调用次数。", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const t = getTask(id); if (!t) return err("找不到任务 " + id);
    log("task_usage", id);
    return json({ usage: t.usage || null, cost_cny: t.cost ?? null, sessions: sessionsForTask(id) });
  });

  return server;
}

export function mcpRoutes(app, authMw) {
  app.post("/mcp", authMw, async (req, res) => {
    const agent = req.who && req.who.via === "oauth" ? "claude-ai" : String(req.query.agent || "mcp").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "mcp";
    const server = build(agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e && e.message || e) }, id: null });
    }
  });
  const notAllowed = (req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
