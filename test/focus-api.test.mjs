import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
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

const reportBlock = (id, fingerprint, content) => '```agent-work-brief\n' + JSON.stringify({ task: id, expectedFingerprint: fingerprint, content }) + '\n```';
async function milestoneTask(title) {
  const task = await (await call('/api/tasks', 'POST', { title, status: '执行中' })).json();
  const route = '/api/tasks/' + task.id + '/focus';
  const view = () => call(route).then(r => r.json());
  return { id: task.id, route, view };
}

test('Claude hook and Codex transcript share a concise card, deduplicate replay and reject stale reports', async () => {
  const t = await milestoneTask('Milestone without final delivery');
  const content = { summary: '道路优先级方案已确认', nextAction: '验证主次道路衔接', decision: '是否包含跨楼层导航？', recommendation: '首版限定单层' };
  const block = reportBlock(t.id, (await t.view()).fingerprint, content);
  await call('/hooks/claude-code?event=Stop&task=' + t.id, 'POST', { last_assistant_message: block });
  const saved = await t.view();
  assert.equal(saved.content.summary, content.summary);
  assert.equal(saved.status, '执行中'); assert.equal(saved.needsDecision, true);
  await call(t.route + '/read', 'POST', { expectedFingerprint: saved.fingerprint });
  const replay = await (await call('/hooks/codex/transcript?task=' + t.id, 'POST', { text: block })).json();
  assert.equal(replay.workBrief.status, 'unchanged'); assert.equal((await t.view()).unread, false);
  await call(t.route, 'PUT', { expectedFingerprint: saved.fingerprint, content: { summary: '更新后的人工结论', nextAction: '只验证单层' } });
  const stale = await (await call('/hooks/codex/transcript?task=' + t.id, 'POST', { text: block })).json();
  assert.equal(stale.workBrief.status, 'rejected');
  assert.equal((await t.view()).content.summary, '更新后的人工结论');
  const activity = await (await call('/api/tasks/' + t.id + '/activity')).json();
  assert(activity.events.some(e => e.kind === 'work_brief_rejected'));
});

test('a combined milestone and delivery processes the brief before receipt, retaining real verification failures', async () => {
  const t = await milestoneTask('Combined delivery');
  const block = reportBlock(t.id, (await t.view()).fingerprint, { summary: '实现完成，验证仍失败', nextAction: '修复路径断连用例' });
  const receipt = '\n```agent-receipt\ntask: ' + t.id + '\nstatus: blocked\nsummary: Original full delivery\nverify:\n  - routing test: fail\nrisks: disconnected nodes\n```';
  await call('/hooks/claude-code?event=Stop&task=' + t.id, 'POST', { last_assistant_message: block + receipt });
  const v = await t.view();
  assert.equal(v.content.summary, '实现完成，验证仍失败');
  assert.equal(v.status, '需介入'); assert.equal(v.reason, '验证未通过');
  assert.equal(v.snapshot.delivery.summary, 'Original full delivery');
  assert.equal(v.snapshot.delivery.verify[0].result, 'fail');
});

test('runner report endpoint rejects cross-task, unsafe and malformed data and leaves business state unchanged', async () => {
  const a = await milestoneTask('Bound task'), b = await milestoneTask('Other task');
  const v = await a.view(), content = { summary: 'Stage ready', nextAction: 'Verify' };
  assert.equal((await fetch(base + a.route + '/report', { method: 'POST' })).status, 401);
  assert.equal((await call(a.route + '/report', 'POST', { text: reportBlock(b.id, v.fingerprint, content) })).status, 400);
  assert.equal((await call(a.route + '/report', 'POST', { text: reportBlock(a.id, v.fingerprint, { ...content, evidence: [{ label: 'unsafe', url: 'javascript:alert(1)' }] }) })).status, 400);
  assert.equal((await call(a.route + '/report', 'POST', { text: '```agent-work-brief\n{broken\n```' })).status, 400);
  assert.equal((await call(a.route + '/report', 'POST', { text: '```agent-work-brief\nnull\n```' })).status, 400);
  assert.equal((await a.view()).fingerprint, v.fingerprint);
  const block = reportBlock(a.id, v.fingerprint, content);
  assert.equal((await (await call(a.route + '/report', 'POST', { text: block })).json()).status, 'updated');
  assert.equal((await (await call(a.route + '/report', 'POST', { text: block })).json()).status, 'unchanged');
  assert.equal((await call(a.route + '/report', 'POST', { text: reportBlock(a.id, v.fingerprint, { ...content, summary: 'Old context' }) })).status, 409);
});

test('resuming a session and fetching the task sheet include current conclusions and reporting instructions', async () => {
  const t = await milestoneTask('Resume context');
  await call(t.route, 'PUT', { expectedFingerprint: (await t.view()).fingerprint, content: { summary: 'Keep the confirmed architecture', nextAction: 'Run the boundary experiment' } });
  const response = await (await call('/hooks/codex?event=SessionStart&task=' + t.id, 'POST', { source: 'resume' })).json();
  const context = response.hookSpecificOutput.additionalContext;
  assert.match(context, /Keep the confirmed architecture/); assert.match(context, /update_work_brief/); assert.match(context, /agent-work-brief/);
  assert.match(await (await call('/api/tasks/' + t.id + '/brief')).text(), /Run the boundary experiment/);
});

test('shell context and brief commands report a stage, preserve links, and surface 409 without queueing', async () => {
  const t = await milestoneTask('Shell stage');
  const run = promisify(execFile), script = path.resolve('kit/scripts/hub.sh');
  const options = { cwd: dir, env: { ...process.env, AGENT_HUB_URL: base, AGENT_HUB_TOKEN: token, AGENT_HUB_TASK: t.id, AGENT_HUB_DISABLE: '0', AGENT_HUB_SPOOL: path.join(dir, 'stage-spool'), AGENT_HUB_CONFIG: path.join(dir, 'missing'), AGENT_HUB_RUNNER_FILE: path.join(dir, 'missing-runner'), CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' } };
  const v = JSON.parse((await run('bash', [script, 'context'], options)).stdout);
  assert.equal(v.expectedFingerprint, v.fingerprint);
  const file = path.join(dir, 'stage.json');
  const content = { summary: 'Experiment documented', nextAction: 'Review result', evidence: [{ label: 'Experiment', url: 'https://example.com/experiment', version: 'fixture-v1' }] };
  fs.writeFileSync(file, JSON.stringify({ expectedFingerprint: v.fingerprint, content }));
  await run('bash', [script, 'brief', file], options);
  assert.equal((await t.view()).content.evidence[0].version, 'fixture-v1');
  await assert.rejects(run('bash', [script, 'brief', file], options), e => e.code === 22 && /409/.test(e.stderr));
  assert(!fs.existsSync(options.env.AGENT_HUB_SPOOL));
});
