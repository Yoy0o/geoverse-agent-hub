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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-lifecycle-"));
const token = "lifecycle-fixture-not-a-deployed-secret";
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

const json = async r => { assert.equal(r.ok, true, await r.clone().text()); return r.json(); };
const create = async (title, status = '执行中') => (await json(await call('/api/tasks', 'POST', { title, status, project: 'pause-fixture' }))).id;
const life = id => call('/api/tasks/' + id + '/lifecycle').then(json);
const task = id => call('/api/tasks/' + id).then(json);
const pauseBody = async (id, extra = {}) => ({ expectedFingerprint: (await life(id)).expectedFingerprint, reason: '临时处理插单', summary: '已确认主通道方案', nextAction: '修复两个断连用例', ...extra });
const pause = async (id, extra = {}) => json(await call('/api/tasks/' + id + '/pause', 'POST', await pauseBody(id, extra)));
const resume = async (id, extra = {}) => call('/api/tasks/' + id + '/resume', 'POST', { expectedFingerprint: (await life(id)).expectedFingerprint, ...extra });

test('runner once receives a pause and actually stops its child before reporting stopped', { timeout: 45000 }, async t => {
  const run = promisify(execFile), repo = path.join(dir, 'runner-repo');
  fs.mkdirSync(path.join(repo, 'scripts/agent'), { recursive: true });
  for (const name of ['task.sh', 'hub.sh']) fs.copyFileSync('kit/scripts/' + name, path.join(repo, 'scripts/agent', name));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
  await run('git', ['init', '-b', 'main'], { cwd: repo });
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture'], { cwd: repo });
  const agent = path.join(dir, 'wait-agent.mjs'), marker = path.join(dir, 'agent.pid'), config = path.join(dir, 'runner.json');
  fs.writeFileSync(agent, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);');
  const rn = (await json(await call('/api/runners', 'POST', { name: 'real-runner-fixture', projects: ['pause-fixture'], mode: 'exec', agents: ['codex'] }))).runner;
  fs.writeFileSync(config, JSON.stringify({ id: rn.id, name: rn.name, projects: { 'pause-fixture': repo }, mode: 'exec', max: 1, kind: 'local', agents: { codex: [process.execPath, agent, marker] } }));
  const id = await create('Real stop fixture', '待执行');
  const dispatched = await json(await call('/api/tasks/' + id + '/dispatch', 'POST', { mode: 'exec', runner: rn.id, agent: 'codex' }));
  const child = spawn(process.execPath, [path.resolve('kit/runner.mjs'), 'once', '--interval', '3'], { cwd: repo, env: { ...process.env, AGENT_HUB_URL: base, AGENT_HUB_TOKEN: token, AGENT_HUB_RUNNER_FILE: config, AGENT_HUB_CONFIG: path.join(dir, 'missing'), AGENT_HUB_DISABLE: '0', AGENT_WORKTREES: path.join(dir, 'worktrees'), CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', pid;
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
  });
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, output);
    if (fs.existsSync(marker) && (await json(await call('/api/runs/' + dispatched.run.id))).status === 'running') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert(fs.existsSync(marker), output); pid = Number(fs.readFileSync(marker, 'utf8'));
  assert.equal((await pause(id)).execution.state, 'stopping');
  const exited = once(child, 'exit'); const [code] = await exited; assert.equal(code, 0, output);
  assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
  assert.equal((await life(id)).execution.state, 'stopped'); assert.equal((await task(id)).status, '已暂停');
  assert.equal((await json(await resume(id))).status, '待执行');
});

test('pause saves a version-checked checkpoint and bidirectional interruption links without clearing evidence', async () => {
  const id = await create('Navigation'), interrupt = await create('Urgent video issue', '待执行');
  assert.equal((await fetch(base + '/api/tasks/' + id + '/pause', { method: 'POST' })).status, 401);
  await json(await call('/api/tasks/' + id + '/focus', 'PUT', { expectedFingerprint: (await life(id)).expectedFingerprint, content: { summary: 'Earlier stage', evidence: [{ label: 'Experiment', url: 'https://example.com/fixture', version: 'v1' }] } }));
  const b = await pauseBody(id, { interruptedBy: interrupt });
  for (const invalid of [{ ...b, nextAction: '' }, { ...b, interruptedBy: id }, { ...b, interruptedBy: 'T-missing' }]) assert.equal((await call('/api/tasks/' + id + '/pause', 'POST', invalid)).status, 400);
  const saved = await json(await call('/api/tasks/' + id + '/pause', 'POST', b));
  assert.equal(saved.status, '已暂停'); assert.equal(saved.execution.state, 'stopped');
  assert.equal(saved.content.evidence[0].version, 'v1'); assert.equal(saved.checkpoint.interruptedBy, interrupt);
  assert.equal((await call('/api/tasks/' + id + '/pause', 'POST', b)).status, 409);
  assert((await life(interrupt)).resumeTasks.some(t => t.id === id && t.nextAction === b.nextAction));
  assert.match((await json(await call('/api/tasks/' + interrupt + '/focus/context'))).brief, new RegExp(id));
  assert.equal((await call('/api/tasks/' + interrupt + '/pause', 'POST', await pauseBody(interrupt, { interruptedBy: id }))).status, 400);
  await json(await call('/api/tasks/' + interrupt + '/transition', 'POST', { to: '已合并' }));
  const focus = await json(await call('/api/focus'));
  assert(focus.items.some(t => t.id === id && t.reason === '插单已结束，可恢复'));
  const backup = await json(await call('/api/export'));
  await json(await call('/api/import', 'POST', backup));
  assert.deepEqual((await task(id)).pauseState, backup.tasks.find(t => t.id === id).pauseState);
  assert.deepEqual((await task(id)).workClock, backup.tasks.find(t => t.id === id).workClock);
});

test('paused work cannot restart through hooks, progress, dispatch, generic writes or a late receipt', async () => {
  const id = await create('Sticky pause'); await pause(id);
  for (const [path, method, body] of [
    ['/start', 'POST', {}], ['/progress', 'POST', { progress: 40 }], ['/dispatch', 'POST', { mode: 'handoff' }], ['/transition', 'POST', { to: '执行中' }],
  ]) assert.equal((await call('/api/tasks/' + id + path, method, body)).status, 409);
  assert.equal((await call('/api/docs/tasks/' + id, 'PATCH', { status: '执行中' })).status, 409);
  assert.equal((await call('/api/docs/tasks/' + id, 'PUT', { title: 'Bypass', status: '执行中' })).status, 409);
  assert.equal((await call('/api/docs/tasks/' + id, 'PATCH', { workClock: {} })).status, 409);
  await json(await call('/hooks/codex?event=SessionStart&task=' + id, 'POST', { source: 'resume' }));
  await json(await call('/api/tasks/' + id + '/receipt', 'POST', { summary: 'Late delivery is retained', status: 'done' }));
  assert.equal((await task(id)).status, '已暂停'); assert.equal((await task(id)).receipt.summary, 'Late delivery is retained');
  assert.equal((await json(await call('/api/runs?task=' + id))).length, 0);
});

test('runner pause waits for real acknowledgement, repeated cancel is not acknowledgement, resume does not spawn', async () => {
  const id = await create('Managed stop');
  const rn = (await json(await call('/api/runners', 'POST', { name: 'pause-runner', projects: ['pause-fixture'], agents: ['codex'], mode: 'exec' }))).runner;
  const { run } = await json(await call('/api/tasks/' + id + '/dispatch', 'POST', { mode: 'exec', runner: rn.id, agent: 'codex' }));
  await json(await call('/api/runners/' + rn.id + '/claim', 'POST', {}));
  await json(await call('/api/runs/' + run.id + '/update', 'POST', { status: 'running' }));
  const p = await pause(id); assert.equal(p.execution.state, 'stopping');
  assert.equal((await resume(id, { confirmedExternalStop: true })).status, 409);
  await json(await call('/api/runs/' + run.id + '/cancel', 'POST', {}));
  assert.equal((await life(id)).execution.state, 'stopping');
  const late = await json(await call('/api/runs/' + run.id + '/update', 'POST', { status: 'ready' }));
  assert.equal(late.run.status, 'running'); assert.equal(late.run.cancel, true);
  const hb = await json(await call('/api/runners/' + rn.id + '/heartbeat', 'POST', { runs: [run.id] }));
  assert(hb.cancel.includes(run.id));
  await json(await call('/api/runs/' + run.id + '/update', 'POST', { status: 'cancelled', exitCode: 143 }));
  const restored = await json(await resume(id));
  assert.equal(restored.status, '待执行'); assert.match(restored.context, /修复两个断连用例/);
  assert.equal((await json(await call('/api/runs?task=' + id))).length, 1);
  assert.equal((await json(await call('/api/runs/' + run.id))).status, 'cancelled');
  await json(await call('/hooks/codex?event=SessionStart&task=' + id + '&run=' + run.id, 'POST', { source: 'resume' }));
  await json(await call('/api/tasks/' + id + '/receipt', 'POST', { summary: 'Delivery after resume, before explicit start', status: 'done' }));
  assert.equal((await call('/api/tasks/' + id + '/progress', 'POST', { progress: 99 })).status, 409);
  assert.equal((await task(id)).status, '待执行'); assert.equal((await json(await call('/api/runs?task=' + id))).length, 1);
  const restarted = await json(await call('/api/tasks/' + id + '/start', 'POST', {}));
  await json(await call('/api/tasks/' + id + '/receipt?run=' + run.id, 'POST', { summary: 'Retired output', status: 'done' }));
  assert.equal((await task(id)).status, '执行中');
  assert.equal((await json(await call('/api/runs/' + restarted.run.id))).status, 'running');
  const activity = await json(await call('/api/tasks/' + id + '/activity'));
  assert(activity.events.some(e => e.kind === 'receipt_late' && e.summary.includes('Retired output')));
  assert(activity.events.every(e => !e.receipt && !e.data));
  const details = await json(await call('/api/tasks/' + id + '/activity?includeReceipts=1'));
  assert(details.events.some(e => e.kind === 'receipt_late' && e.receipt.summary === 'Retired output' && e.run === run.id));
  assert(details.events.every(e => !e.data));
});

test('external execution needs an explicit stop confirmation and paused queues cannot be claimed', async () => {
  const id = await create('Manual stop');
  await json(await call('/api/tasks/' + id + '/start', 'POST', { agent: 'codex', location: 'cloud' }));
  assert.equal((await pause(id)).execution.state, 'external');
  assert.equal((await resume(id)).status, 409);
  assert.equal((await json(await resume(id, { confirmedExternalStop: true }))).status, '待执行');
  assert((await task(id)).pauseState.externalStopConfirmedAt);
  const queued = await create('Paused queue', '待执行');
  const rn = (await json(await call('/api/runners', 'POST', { name: 'queue-runner', projects: ['pause-fixture'], mode: 'prepare' }))).runner;
  await json(await call('/api/tasks/' + queued + '/dispatch', 'POST', { mode: 'prepare', runner: rn.id }));
  await pause(queued);
  assert.equal((await json(await call('/api/runners/' + rn.id + '/claim', 'POST', {}))).run, null);
});

test('workflow time freezes through pause and ready, survives backup, and resumes only on start', async () => {
  const id = await create('Measured time');
  const t = await task(id), now = Date.now();
  t.workClock = { activeMs: 120000, runningSince: new Date(now - 60000).toISOString(), trackedSince: new Date(now - 180000).toISOString(), partial: false };
  await json(await call('/api/import', 'POST', { app: 'agent-workbench', tasks: [t] }));
  const paused = await pause(id); assert(paused.activeMs >= 180000 && paused.activeMs < 183000);
  await new Promise(r => setTimeout(r, 25)); assert.equal((await life(id)).activeMs, paused.activeMs);
  const resumed = await json(await resume(id)); assert.equal(resumed.activeMs, paused.activeMs);
  await new Promise(r => setTimeout(r, 25)); assert.equal((await life(id)).activeMs, paused.activeMs);
  await json(await call('/api/tasks/' + id + '/start', 'POST', {}));
  assert((await task(id)).workClock.runningSince); assert((await life(id)).activeMs >= paused.activeMs);
});

test('MCP and shell expose the same checkpoint lifecycle and reject stale resume', async () => {
  const id = await create('MCP checkpoint');
  const client = new Client({ name: 'pause-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp?agent=codex'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  try {
    const args = { id, ...await pauseBody(id) };
    assert(!(await client.callTool({ name: 'pause_task', arguments: args })).isError);
    assert((await client.callTool({ name: 'start_task', arguments: { id } })).isError);
    assert((await client.callTool({ name: 'resume_task', arguments: { id, expectedFingerprint: args.expectedFingerprint } })).isError);
    const context = JSON.parse((await client.callTool({ name: 'get_work_context', arguments: { id } })).content[0].text);
    assert.equal(context.lifecycle.status, '已暂停');
    assert(!(await client.callTool({ name: 'resume_task', arguments: { id, expectedFingerprint: context.expectedFingerprint } })).isError);
  } finally { await client.close(); }
  const run = promisify(execFile), cwd = path.join(dir, 'script-repo'); fs.mkdirSync(cwd);
  await run('git', ['init', '-b', 'main'], { cwd });
  const env = { ...process.env, AGENT_HUB_URL: base, AGENT_HUB_TOKEN: token, AGENT_HUB_CONFIG: path.join(dir, 'missing'), AGENT_HUB_DISABLE: '0', CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' };
  const script = path.resolve('kit/scripts/task.sh'), file = path.join(dir, 'pause.json');
  fs.writeFileSync(file, JSON.stringify(await pauseBody(id)));
  await run('bash', [script, 'pause', id, file], { cwd, env });
  const context = JSON.parse((await run('bash', [script, 'context', id], { cwd, env })).stdout);
  assert.equal(context.status, '已暂停');
  await assert.rejects(run('bash', [script, 'run', id, 'codex'], { cwd, env }), e => /任务已暂停/.test(e.stderr));
  fs.writeFileSync(file, JSON.stringify({ expectedFingerprint: context.expectedFingerprint }));
  await run('bash', [script, 'resume', id, file], { cwd, env });
  assert.equal((await task(id)).status, '待执行');
});

