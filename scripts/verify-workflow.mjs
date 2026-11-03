// Always owns a fresh loopback-only Hub. No option accepts an existing Hub URL or data directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { serve: { type: 'boolean', default: false }, port: { type: 'string' } } });
if (values.port && (!values.serve || !/^\d+$/.test(values.port) || +values.port < 1 || +values.port > 65535)) throw new Error('--port 只用于 --serve，范围为 1–65535。');
const keep = values.serve, output = path.join(root, '.local-verification');
if (keep) await fs.mkdir(output, { recursive: true });
const dir = await fs.mkdtemp(path.join(keep ? output : os.tmpdir(), 'hub-workflow-'));
const token = 'ah_' + randomBytes(24).toString('base64url');
await fs.writeFile(path.join(dir, 'hub-token'), token + '\n', { mode: 0o600 });
let hub, client, base, interrupted = false;
const checks = [], mark = label => { checks.push(label); console.log('✓ ' + label); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// A whitelist prevents inherited sync, runner, model, public URL, proxy or production credentials.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|TMPDIR|LANG|LC_ALL|TZ)$/i.test(key)));
async function portNumber() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function stop() {
  await client?.close().catch(() => {}); client = null;
  if (hub?.pid && hub.exitCode === null && hub.signalCode === null) {
    const closed = once(hub, 'exit'); hub.kill();
    const timer = setTimeout(() => hub.kill('SIGKILL'), 2000); timer.unref();
    await closed; clearTimeout(timer);
  }
}
async function start(port) {
  base = 'http://127.0.0.1:' + port;
  hub = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: root, env: { ...env, HUB_DATA_DIR: dir, HUB_TOKEN: token, HOST: '127.0.0.1', PORT: String(port), HUB_NAME: '本地流程验证（仅样例）', OAUTH_ENABLED: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = ''; hub.stderr.on('data', data => { error = (error + data).slice(-2000); });
  let spawnError; hub.on('error', e => { spawnError = e; });
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    if (interrupted || hub.exitCode !== null || hub.signalCode !== null) throw new Error('验证 Hub 未能启动：' + error);
    try { const caps = await api('/api/capabilities'); if (caps.hub?.name === '本地流程验证（仅样例）') return; } catch { /* own server starting; never reuse a different process */ }
    await pause(50);
  }
  throw new Error('验证 Hub 启动超时；端口可能已被占用。');
}
async function api(route, method = 'GET', body, expectedStatus = 200) {
  const r = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(r.status, expectedStatus, method + ' ' + route + ': ' + await r.clone().text());
  return r.json();
}
const taskPath = id => '/api/tasks/' + encodeURIComponent(id);
const task = id => api(taskPath(id));
const focus = id => api(taskPath(id) + '/focus');
const delivery = id => api(taskPath(id) + '/delivery');
const life = id => api(taskPath(id) + '/lifecycle');
async function mcp(name, args = {}, json = true) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
  assert(!r.isError, name + ' failed: ' + JSON.stringify(r));
  return json ? JSON.parse(r.content[0].text) : r.content[0].text;
}
const create = async (title, acceptance) => (await api('/api/tasks', 'POST', { title: '[本地验证] ' + title, project: '验证样例 · GIS', status: '待执行', goal: '仅验证 Hub 数据流，不代表真实业务交付', acceptance, allow: '验证样例', deny: '生产数据' })).id;
const receiptBody = (version, summary, result = 'pass', run) => ({ status: 'done', summary: '[模拟回执] ' + summary, version, changed: ['fixtures/navigation.json'], verify: [{ cmd: '模拟验证结果（非真实业务测试）', result }], scope: 'ok', risks: '无', ...(run ? { run } : {}) });
const submit = (id, body) => api(taskPath(id) + '/receipt', 'POST', body);
const reviewBody = async id => {
  const d = await delivery(id);
  return { action: 'merge', expectedDeliveryId: d.currentId, expectedFingerprint: d.expectedFingerprint, verificationConfirmed: true,
    acceptedCriteria: d.selected.requirements.acceptance.map((_, i) => i), note: '自动化样例验收，仅用于验证版本绑定，不代表真实业务批准' };
};
const link = (tab, id, revision) => { const u = new URL(base); u.searchParams.set('tab', tab); if (id) u.searchParams.set('task', id); if (revision) u.searchParams.set('revision', revision); return u.href; };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; hub?.kill(); });

try {
  const port = keep ? Number(values.port || 8789) : await portNumber();
  await start(port);
  assert.deepEqual(await api('/api/tasks'), []);
  const caps = await api('/api/capabilities'); assert.equal(caps.sample, false); assert.equal(caps.oauth, false); assert.equal(caps.sync.configured, false);
  assert.equal((await fetch(base + '/api/tasks')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/tasks', { headers: { Cookie: cookie } })).status, 200);
  mark('独立空库、同步与模型关闭；令牌和网页登录均可用');
  client = new Client({ name: 'isolated-workflow-verification', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp?agent=codex'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));

  const streamAbort = new AbortController();
  const stream = await fetch(base + '/api/stream', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(10000)]) });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  let main;
  try {
    main = await create('园区导航主次道路调研', ['主次道路衔接证据完整', '断连用例记录可复用']);
    const decoder = new TextDecoder(); let events = '';
    while (!events.includes('"id":"' + main + '"')) {
      const { done, value } = await reader.read(); assert.equal(done, false); events += decoder.decode(value, { stream: true });
    }
    assert.match(events, /event: doc/);
  } finally { streamAbort.abort(); await reader.cancel().catch(() => {}); }
  mark('创建任务后 SSE 推送同一任务编号，供工作台实时更新');
  const urgent = await create('临时插单：Safari 视频白屏', ['记录复现与兼容修复证据']);
  const target = await create('下一期导航需求拆解', ['引用已确认版本并单独验收新范围']);
  // Keep a second pause checkpoint open for manual inspection after the full path completes.
  const ongoing = await create('跨楼层调研暂停点', ['恢复后验证电梯换层']);
  await api(taskPath(ongoing) + '/pause', 'POST', { expectedFingerprint: (await life(ongoing)).expectedFingerprint, reason: '等待插单处理结果',
    summary: '已整理换层方案和两个疑点', nextAction: '验证电梯换层', interruptedBy: urgent });
  const firstRun = (await api(taskPath(main) + '/start', 'POST', { agent: 'codex', location: 'local' })).run.id;
  const original = await mcp('get_work_context', { id: main });
  const briefReport = '```agent-work-brief\n' + JSON.stringify({ task: main, expectedFingerprint: original.expectedFingerprint,
    content: { summary: '主次道路方案已有样例，剩余两个断连场景', nextAction: '补两个断连用例' } }) + '\n```';
  await api('/hooks/claude-code?event=Stop&task=' + main, 'POST', { last_assistant_message: briefReport });
  const read = await focus(main);
  assert.match(read.content.summary, /主次道路/);
  assert.equal((await mcp('get_work_context', { id: main })).content.summary, read.content.summary);
  await api(taskPath(main) + '/focus/read', 'POST', { expectedFingerprint: read.fingerprint });
  assert.equal((await api('/hooks/codex/transcript?task=' + main, 'POST', { text: briefReport })).workBrief.status, 'unchanged');
  assert.equal((await focus(main)).unread, false);
  mark('REST 开工 → Claude 钩子摘要 → MCP 读取 → Codex 重放去重，不重置已读');

  const paused = await mcp('pause_task', { id: main, expectedFingerprint: (await life(main)).expectedFingerprint,
    reason: '临时处理兼容问题', summary: read.content.summary, nextAction: '继续补两个断连用例', interruptedBy: urgent });
  assert.equal(paused.status, '已暂停'); assert.equal(paused.execution.state, 'external');
  assert((await life(urgent)).resumeTasks.some(t => t.id === main));
  await api(taskPath(main) + '/resume', 'POST', { expectedFingerprint: (await life(main)).expectedFingerprint }, 409);
  await submit(main, receiptBody('late-paused-v1', '暂停后旧回执', 'pass', firstRun));
  assert.equal((await task(main)).status, '已暂停');
  mark('插单保存断点和双向关联；未确认停止不能恢复，迟到回执不能恢复任务');

  await mcp('start_task', { id: urgent }, false);
  await mcp('submit_receipt', { task: urgent, ...receiptBody('safari-fixture-v1', '记录白屏复现和修复样例') }, false);
  await api(taskPath(urgent) + '/review', 'POST', await reviewBody(urgent));
  assert((await api('/api/focus')).items.some(t => t.id === main && t.reason === '插单已结束，可恢复'));
  // No external Agent was launched: this run is a synthetic registration owned by this script.
  const resumed = await mcp('resume_task', { id: main, expectedFingerprint: (await life(main)).expectedFingerprint, confirmedExternalStop: true });
  assert.equal(resumed.status, '待执行'); assert.match(resumed.context, /继续补两个断连用例/);
  const secondRun = (await api(taskPath(main) + '/start', 'POST', { agent: 'codex' })).run.id;
  assert.notEqual(firstRun, secondRun);
  const late = await submit(main, receiptBody('late-retired-v2', '旧执行返回', 'pass', firstRun));
  assert.equal(late.archived, true); assert.equal((await task(main)).status, '执行中');
  mark('插单验收 → 提醒恢复 → 显式再开工；新旧执行隔离');

  await submit(main, receiptBody('navigation-fixture-v1', '一个断连用例仍失败', 'fail', secondRun));
  assert.equal((await task(main)).status, '需介入');
  await api(taskPath(main) + '/review', 'POST', await reviewBody(main), 409);
  const v2 = await submit(main, receiptBody('navigation-fixture-v2', '两个断连用例已有修复证据'));
  const staleReview = await reviewBody(main);
  const v3 = await submit(main, receiptBody('navigation-fixture-v3', '补齐主次道路衔接对照'));
  const replay = await submit(main, receiptBody('navigation-fixture-v3', '补齐主次道路衔接对照'));
  assert.equal(replay.skipped, true); assert.equal(replay.deliveryId, v3.deliveryId);
  await api(taskPath(main) + '/review', 'POST', staleReview, 409);
  await api(taskPath(main) + '/check', 'POST', { deliveryId: v3.deliveryId, version: 'navigation-fixture-v3', ok: true, verify: [{ cmd: '模拟机器检查', result: 'pass' }] });
  await api(taskPath(main) + '/review', 'POST', await reviewBody(main));
  assert.equal((await delivery(main)).accepted, true);
  mark('失败回执阻断验收；旧页面验收被拒绝；检查与人工确认绑定当前版本');

  const found = await mcp('search_deliveries', { q: '园区导航', scope: 'accepted' });
  assert(found.items.some(d => d.deliveryId === v3.deliveryId));
  const targetContext = await mcp('get_work_context', { id: target });
  await mcp('defer_task_attention', { id: target, expectedFingerprint: targetContext.expectedFingerprint, minutes: 60 });
  assert.equal((await focus(target)).deferred, true);
  await mcp('reuse_delivery', { id: target, expectedFingerprint: targetContext.expectedFingerprint, sourceTaskId: main, deliveryId: v3.deliveryId,
    expectedSourceFingerprint: (await delivery(main)).expectedFingerprint, note: '复用道路衔接证据，新范围仍需独立验收' });
  assert.equal((await focus(target)).deferred, false);
  assert.equal((await task(target)).status, '待执行'); assert.equal((await delivery(target)).accepted, false);
  const targetView = await focus(target);
  await api('/api/focus/read', 'POST', { items: [{ id: target, expectedFingerprint: targetView.fingerprint }] });
  assert.equal((await focus(target)).unread, false);
  await api(taskPath(main) + '/transition', 'POST', { to: '待执行' });
  await api(taskPath(main) + '/delivery/' + v2.deliveryId + '/select', 'POST', { expectedFingerprint: (await delivery(main)).expectedFingerprint });
  assert.equal((await focus(target)).unread, true);
  assert.equal((await focus(target)).snapshot.relations[0].delivery.id, v3.deliveryId);
  assert.equal((await focus(target)).snapshot.relations[0].delivery.current, false);
  // Return the fixture source to a reviewed latest version, leaving the reference unchanged.
  await api(taskPath(main) + '/delivery/' + v3.deliveryId + '/select', 'POST', { expectedFingerprint: (await delivery(main)).expectedFingerprint });
  await api(taskPath(main) + '/review', 'POST', await reviewBody(main));
  mark('成果检索 → 稍后处理 → 固定版本引用 → 批量已读；来源变化重新提醒且不继承验收');

  const deferred = await create('前沿跟踪：稍后处理的普通信息', ['判断是否值得开实验']);
  await api(taskPath(deferred) + '/focus/defer', 'POST', { expectedFingerprint: (await focus(deferred)).fingerprint, minutes: 60 });
  const backup = await api('/api/export');
  const before = Object.fromEntries(await Promise.all([main, urgent, target, ongoing, deferred].map(async id => [id, await task(id)])));
  for (const id of Object.keys(before)) await api('/api/docs/tasks/' + id, 'DELETE');
  assert.deepEqual(await api('/api/tasks'), []);
  await api('/api/import', 'POST', backup);
  await stop(); await start(port);
  for (const [id, expected] of Object.entries(before)) {
    const current = await task(id);
    for (const field of ['status', 'pauseState', 'deliveries', 'deliveryReviews', 'deliveryChecks', 'currentDelivery', 'focus']) assert.deepEqual(current[field], expected[field], id + '.' + field);
  }
  assert.equal((await delivery(main)).accepted, true);
  assert.equal((await focus(deferred)).deferred, true);
  assert((await api('/api/deliveries?scope=accepted')).items.some(d => d.deliveryId === v3.deliveryId));
  mark('样例导出、恢复和服务重启后，断点、已读、延后、版本引用及验收记录保持一致');

  const links = { '今日待办': link('today'), '已验收成果': link('results'), '常规任务与当前成果': link('board', main, v3.deliveryId),
    '历史版本': link('board', main, v2.deliveryId), '临时插单': link('board', urgent), '等待恢复的断点': link('board', ongoing), '复用成果的新任务': link('board', target) };
  for (const url of Object.values(links)) {
    const page = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/); await page.body.cancel();
  }
  const report = { verifiedAt: new Date().toISOString(), version: caps.version, origin: base, checks, links, dataDir: dir, tokenFile: path.join(dir, 'hub-token') };
  console.log(`\n完整数据流验证通过（${checks.length} 组）。样例回执为模拟内容，未启动真实 Agent 或执行业务代码。`);
  if (keep) {
    await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'latest-links.md'), '# 本地验证入口\n\n仅当前启动验证实例的电脑可访问。\n\n' + Object.entries(links).map(([name, url]) => '- [' + name + '](' + url + ')').join('\n') + '\n\n登录令牌保存在 `' + report.tokenFile + '`，用本机编辑器读取后登录；不要提交或分享令牌。\n');
    for (const [name, url] of Object.entries(links)) console.log(name + '：' + url);
    console.log('本机登录令牌文件：' + report.tokenFile);
    console.log('验证链接已更新：' + path.join(output, 'latest-links.md') + '\n按 Ctrl+C 停止；数据仅保留在独立样例目录。');
    if (hub.exitCode === null && hub.signalCode === null) await once(hub, 'exit');
    if (!interrupted) throw new Error('本地验证服务意外退出。');
  }
} catch (error) {
  console.error('数据流验证未通过：' + error.message); process.exitCode = 1;
} finally {
  await stop();
  if (!keep) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
