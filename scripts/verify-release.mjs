// Read-only verification against the configured production origin. Credentials
// come from the existing Agent Hub environment and are never printed.
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unstable_readConfig } from 'wrangler';
import { version } from '../src/version.js';

const root = new URL('../', import.meta.url);
try {
  const config = unstable_readConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) });
  const origin = new URL(config.vars.PUBLIC_URL).origin;
  const expected = execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status','--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('请在无未提交改动的发布提交上验收。');
  const token = process.env.AGENT_HUB_TOKEN || process.env.HUB_TOKEN;
  if (!token) throw new Error('需要当前环境中的 AGENT_HUB_TOKEN；请使用已有 Hub 接入配置，不要把令牌写进命令或仓库。');
  const headers = { Authorization: 'Bearer ' + token };
  if (process.env.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  if (process.env.CF_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  async function get(path) {
    const response = await fetch(origin + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}；请检查发布与已有 Access/Hub 身份。`);
    return response;
  }
  async function json(path) {
    const response = await get(path);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`${path} 没有返回 JSON，可能仍在登录页。`);
    return response.json();
  }
  const health = await json('/api/health');
  if (health.version !== version || health.build?.commit !== expected || health.build?.dirty !== false) throw new Error('线上版本、提交或工作区标识与发布提交不一致。');
  const caps = await json('/api/capabilities');
  if (caps.version !== version || caps.build?.commit !== expected) throw new Error('能力接口与健康接口的版本不一致。');
  const focus = await json('/api/focus');
  if (!Array.isArray(focus.items) || !focus.counts) throw new Error('决策卡接口未就绪。');
  for (const file of ['index.html','shim.js','focus.js','focus.css','task-edits.js','delivery.js']) {
    const expectedHash = createHash('sha256').update(await fs.readFile(new URL('public/' + file, root))).digest('hex');
    const bytes = await (await get(file === 'index.html' ? '/' : '/' + file)).arrayBuffer();
    const actualHash = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    if (actualHash !== expectedHash || health.build.assets?.[file] !== expectedHash) throw new Error(`线上静态文件 ${file} 与发布提交不一致。`);
  }
  const client = new Client({ name: 'hub-release-verification', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?agent=release-check', origin), { requestInit: { headers, redirect: 'manual' } }));
    const names = new Set((await client.listTools()).tools.map(tool => tool.name));
    for (const name of ['get_focus','get_work_context','update_work_brief']) if (!names.has(name)) throw new Error(`MCP 缺少 ${name}。`);
  } finally { await client.close(); }
  console.log(`发布验收通过：v${version} / ${expected.slice(0,12)}；API、决策卡、静态文件和 MCP 工具一致。`);
} catch (error) {
  console.error('发布验收未通过：' + error.message);
  process.exitCode = 1;
}
