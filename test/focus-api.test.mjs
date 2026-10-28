import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-focus-"));
const token = "focus-fixture-not-a-deployed-secret";
let hub, base, logs = "";
const call = (p, method = "GET", body) => fetch(base + p, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
before(async () => {
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve)); base = "http://127.0.0.1:" + port;
  hub = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], { env: { ...process.env, HUB_DATA_DIR: dir, HUB_TOKEN: token, HOST: "127.0.0.1", PORT: String(port), OAUTH_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout.on("data", (d) => logs += d); hub.stderr.on("data", (d) => logs += d);
  for (let n = 0; n < 100; n++) {
    if (hub.exitCode !== null) throw new Error(logs);
    try { if ((await call("/api/health")).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Service did not start: " + logs);
});
after(async () => {
  if (hub && hub.exitCode === null) { const closed = once(hub, "exit"); hub.kill(); await closed; }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("REST focus endpoints share authentication, concurrency and backup behavior", async () => {
  assert.equal((await fetch(base + "/api/focus")).status, 401);
  const task = await (await call("/api/tasks", "POST", { title: "Read-only query scope", goal: "Deliver the first query" })).json();
  const route = "/api/tasks/" + task.id + "/focus";
  const original = await (await call(route)).json();
  const saved = await (await call(route, "PUT", { expectedFingerprint: original.fingerprint, content: { summary: "Query path prepared", decision: "Ship query first?", recommendation: "Keep writes for the next slice" } })).json();
  assert.equal(saved.needsDecision, true);
  assert.equal((await call(route + "/read", "POST", { expectedFingerprint: original.fingerprint })).status, 409);
  const read = await (await call(route + "/read", "POST", { expectedFingerprint: saved.fingerprint })).json();
  assert.equal(read.unread, false); assert.equal(read.needsDecision, true);
  const accepted = await (await call(route + "/decision", "POST", { expectedFingerprint: saved.fingerprint, action: "accept" })).json();
  assert.equal(accepted.needsDecision, false);
  assert.equal((await (await call("/api/tasks/" + task.id)).json()).status, "待执行");
  const backup = await (await call("/api/export")).json();
  assert.equal(backup.tasks.find((t) => t.id === task.id).focus.content.summary, "Query path prepared");
  assert.equal((await call("/api/import", "POST", backup)).status, 200);
  assert.equal((await (await call(route)).json()).unread, false);
  assert.match((await (await call(route + "/context")).json()).brief, /Keep writes/);
  assert.equal((await call(route, "PUT", { expectedFingerprint: saved.fingerprint, content: { evidence: [{ label: "unsafe", url: "javascript:alert(1)" }] } })).status, 400);
});
test("MCP can resume and update concise context but never silently mark it read", async () => {
  const task = await (await call("/api/tasks", "POST", { title: "MCP work context" })).json();
  const client = new Client({ name: "focus-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp?agent=codex"), { requestInit: { headers: { Authorization: "Bearer " + token } } });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["get_focus", "get_work_context", "update_work_brief"]) assert(names.includes(name));
    const run = async (name, args) => client.callTool({ name, arguments: args });
    const context = JSON.parse((await run("get_work_context", { id: task.id })).content[0].text);
    assert.match(context.taskBrief, /MCP work context/);
    const response = await run("update_work_brief", { id: task.id, expectedFingerprint: context.expectedFingerprint, content: { summary: "Stable interface", nextAction: "Run the experiment" } });
    assert(!response.isError);
    assert.equal((await (await call("/api/tasks/" + task.id + "/focus")).json()).unread, true);
    const stale = await run("update_work_brief", { id: task.id, expectedFingerprint: context.expectedFingerprint, content: { summary: "Stale draft" } });
    assert.equal(stale.isError, true);
    const daily = JSON.parse((await run("get_focus", {})).content[0].text);
    assert(daily.updates.some((t) => t.id === task.id));
  } finally { await client.close(); }
});
