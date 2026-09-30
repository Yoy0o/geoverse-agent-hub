// MCP 客户端测试：node test/mcp.mjs <hub地址> <令牌> <任务编号>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, token, id] = process.argv.slice(2);
const assert = (c, m) => { if (!c) { console.error("✗ " + m); process.exit(1); } console.log("✓ " + m); };
const t = new StreamableHTTPClientTransport(new URL(url + "/mcp?agent=codex"), { requestInit: { headers: { Authorization: "Bearer " + token } } });
const c = new Client({ name: "e2e", version: "1" });
await c.connect(t);
const names = (await c.listTools()).tools.map((x) => x.name);
assert(["today", "get_task", "submit_receipt", "move_task", "create_task"].every((n) => names.includes(n)), "工具齐全：" + names.join(","));
const txt = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { text: r.content[0].text, err: !!r.isError }; };
const today = JSON.parse((await txt("today", {})).text);
assert(Array.isArray(today.attention), "today 返回待办");
assert((await txt("get_task", { id })).text.includes("# 任务 " + id), "get_task 返回任务单");
assert((await txt("get_task", { id: "T000000-xxx" })).err, "不存在的任务返回错误");
const r = await txt("submit_receipt", { task: id, status: "done", summary: "MCP 提交的回执", changed: ["src/c.js"], verify: [{ cmd: "bash scripts/agent/verify.sh", result: "pass" }], scope: "ok", risks: "无" });
assert(r.text.includes("待评审"), "submit_receipt → 待评审");
assert((await txt("move_task", { id, action: "rework" })).err, "退回缺原因时报错");
assert((await txt("move_task", { id, action: "rework", reasons: ["验证不足"], note: "补边界测试" })).text.includes("执行中"), "move_task rework → 执行中");
const n = await txt("create_task", { title: "MCP 新建的任务", project: "demo", acceptance: ["make test 通过"] });
assert(/已创建 T\d{6}-/.test(n.text), "create_task");
await c.close();
