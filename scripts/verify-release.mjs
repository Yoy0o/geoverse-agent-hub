// Read-only business verification. Never submit receipts, reviews or sample data here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unstable_readConfig } from 'wrangler';

export const ASSETS = ['index.html', 'shim.js', 'focus.js', 'focus.css', 'task-edits.js', 'delivery.js', 'results.js'];
export const WORKFLOW_TOOLS = ['get_focus', 'get_work_context', 'update_work_brief', 'start_task', 'submit_receipt', 'move_task', 'pause_task', 'resume_task', 'get_delivery', 'select_delivery', 'defer_task_attention', 'search_deliveries', 'reuse_delivery'];
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };

// Resolve once, then read ONLY this immutable tree, even when the verifier is on a newer branch.
export function releaseSnapshot(ref = 'HEAD', cwd = root) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();
  requireThat(/^[a-f0-9]{40}$/.test(commit), '无法解析发布提交。');
  const read = path => execFileSync('git', ['show', commit + ':' + path], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return { commit, version: JSON.parse(read('package.json')).version,
    assets: Object.fromEntries(ASSETS.map(file => [file, hash(read('public/' + file))])) };
}

export async function openReleaseMcp(origin, headers) {
  const client = new Client({ name: 'hub-release-verification', version: '2' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?agent=release-check', origin), {
      requestInit: { headers, redirect: 'manual' },
      fetch: (url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(15000)]) }),
    }), { timeout: 15000 });
    return client;
  } catch { await client.close().catch(() => {}); throw new Error('MCP 连接失败；请检查发布与已有 Access/Hub 身份。'); }
}

export async function verifyRelease({ origin, expected, headers, fetchImpl = fetch, openMcp = openReleaseMcp }) {
  const url = new URL(origin);
  requireThat(url.origin === origin && !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))), '验收地址必须是 HTTPS origin（本机允许 HTTP），不能包含路径、凭据或查询参数。');
  async function get(path) {
    const r = await fetchImpl(origin + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    requireThat(r.ok, `${path} 返回 HTTP ${r.status}；请检查发布与已有 Access/Hub 身份。`);
    return r;
  }
  async function json(path) {
    const r = await get(path);
    requireThat(r.headers.get('content-type')?.includes('application/json'), `${path} 没有返回 JSON，可能仍在登录页。`);
    return r.json();
  }
  for (const route of ['/api/health', '/api/capabilities']) {
    const data = await json(route);
    requireThat(data.version === expected.version && data.build?.commit === expected.commit && data.build?.dirty === false, `${route} 的版本、提交或工作区标识与发布提交不一致。`);
    for (const file of ASSETS) requireThat(data.build.assets?.[file] === expected.assets[file], `${route} 缺少正确的 ${file} 指纹。`);
  }
  const focus = await json('/api/focus');
  requireThat(['items', 'remaining', 'updates', 'deferred'].every(key => Array.isArray(focus[key])) && ['attention', 'urgent', 'unread', 'deferred'].every(key => Number.isFinite(focus.counts?.[key])), '新版注意力队列未就绪。');
  for (const scope of ['accepted', 'current', 'all']) {
    const result = await json('/api/deliveries?scope=' + scope + '&limit=1');
    requireThat(Array.isArray(result.items) && Number.isFinite(result.total) && result.limit === 1, '成果检索接口未就绪。');
  }
  const tasks = await json('/api/tasks');
  requireThat(Array.isArray(tasks), '任务列表接口未就绪。');
  const id = tasks[0]?.id;
  if (id) {
    const path = '/api/tasks/' + encodeURIComponent(id);
    const life = await json(path + '/lifecycle'), delivery = await json(path + '/delivery');
    requireThat(life.id === id && typeof life.expectedFingerprint === 'string', '任务生命周期接口未就绪。');
    requireThat(delivery.task === id && Array.isArray(delivery.versions) && typeof delivery.expectedFingerprint === 'string', '成果版本接口未就绪。');
  }
  for (const file of ASSETS) {
    const bytes = await (await get(file === 'index.html' ? '/' : '/' + file)).arrayBuffer();
    requireThat(hash(Buffer.from(bytes)) === expected.assets[file], `线上静态文件 ${file} 与发布提交不一致。`);
  }
  const client = await openMcp(origin, headers);
  try {
    const names = new Set(), cursors = new Set(); let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 });
      page.tools.forEach(tool => names.add(tool.name)); cursor = page.nextCursor;
      requireThat(!cursor || !cursors.has(cursor), 'MCP 工具分页重复。'); cursors.add(cursor);
    } while (cursor);
    for (const name of WORKFLOW_TOOLS) requireThat(names.has(name), `MCP 缺少 ${name}。`);
    const read = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
      requireThat(!result.isError, `MCP ${name} 调用失败。`);
      return JSON.parse(result.content.find(c => c.type === 'text').text);
    };
    requireThat(Array.isArray((await read('get_focus')).deferred), 'MCP 注意力队列未就绪。');
    requireThat(Array.isArray((await read('search_deliveries', { limit: 1 })).items), 'MCP 成果检索未就绪。');
    if (id) {
      requireThat(typeof (await read('get_work_context', { id })).expectedFingerprint === 'string', 'MCP 上下文未就绪。');
      requireThat((await read('get_delivery', { id })).task === id, 'MCP 成果版本未就绪。');
    }
    return { commit: expected.commit, version: expected.version, assets: ASSETS.length, workflowTools: WORKFLOW_TOOLS.length, taskSampled: !!id };
  } finally { await client.close(); }
}

async function main() {
  try {
    const { values } = parseArgs({ options: { ref: { type: 'string', default: 'HEAD' }, url: { type: 'string' } } });
    const expected = releaseSnapshot(values.ref);
    const config = unstable_readConfig({ config: root + '/wrangler.jsonc' });
    const origin = values.url || config.vars.PUBLIC_URL;
    const token = process.env.AGENT_HUB_TOKEN || process.env.HUB_TOKEN;
    requireThat(token, '需要当前环境中的 AGENT_HUB_TOKEN；请使用已有 Hub 接入配置，不要把令牌写进命令或仓库。');
    const headers = { Authorization: 'Bearer ' + token };
    requireThat(!!process.env.CF_ACCESS_CLIENT_ID === !!process.env.CF_ACCESS_CLIENT_SECRET, 'Access 服务凭据需同时配置 ID 与 Secret。');
    if (process.env.CF_ACCESS_CLIENT_ID) {
      headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
    }
    const result = await verifyRelease({ origin, expected, headers });
    console.log(`发布只读验收通过：v${result.version} / ${result.commit.slice(0, 12)}；${result.assets} 个静态文件、${result.workflowTools} 个工作流工具及 REST/MCP 读取通过。`);
    if (!result.taskSampled) console.log('实例没有任务，跳过逐任务读取；写入流程请另运行 npm run verify:workflow。');
  } catch (error) {
    console.error('发布验收未通过：' + error.message); process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
