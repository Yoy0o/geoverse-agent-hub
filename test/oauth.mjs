// 模拟 claude.ai 自定义连接器的 OAuth 流程：node test/oauth.mjs（会自己启动一个开启 OAuth 的 hub）
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8793, BASE = `http://localhost:${PORT}`, TOKEN = "oauth-test-token";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-oauth-"));
const hub = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], { env: { ...process.env, PORT: String(PORT), HUB_TOKEN: TOKEN, HUB_DATA_DIR: dir, PUBLIC_URL: BASE, OAUTH_ENABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; hub.stdout.on("data", (d) => (log += d)); hub.stderr.on("data", (d) => (log += d));
const fail = (m) => { console.error("✗ " + m + "\n" + log); hub.kill(); process.exit(1); };
const ok = (c, m) => (c ? console.log("✓ " + m) : fail(m));
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch { /* 等待 */ } await new Promise((r) => setTimeout(r, 100)); }

const r401 = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
ok(r401.status === 401 && /resource_metadata=".*oauth-protected-resource\/mcp"/.test(r401.headers.get("www-authenticate") || ""), "未授权 401 + resource_metadata");
const prm = await (await fetch(BASE + "/.well-known/oauth-protected-resource/mcp")).json();
ok(prm.resource === BASE + "/mcp" && prm.authorization_servers[0].startsWith(BASE), "受保护资源元数据 resource 与 MCP 地址一致");
const asm = await (await fetch(BASE + "/.well-known/oauth-authorization-server")).json();
ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes("S256"), "授权服务器元数据含 DCR 与 S256");

const redirect = "https://claude.ai/api/mcp/auth_callback";
const reg = await (await fetch(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
ok(!!reg.client_id, "动态客户端注册");

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const au = new URL(asm.authorization_endpoint);
Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: BASE + "/mcp" }).forEach(([k, v]) => au.searchParams.set(k, v));
const page = await (await fetch(au)).text();
const rid = (page.match(/name="rid" value="([^"]+)"/) || [])[1];
ok(rid && page.includes("claude.ai"), "授权页显示回跳域名并带请求编号");
const bad = await fetch(BASE + "/oauth/approve", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid, token: "wrong" }) });
ok(bad.status === 401, "错误令牌不能批准");
const good = await fetch(BASE + "/oauth/approve", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid, token: TOKEN }) });
const loc = new URL(good.headers.get("location") || "http://x/");
ok(good.status === 302 && loc.origin === "https://claude.ai" && loc.searchParams.get("state") === "st-1" && loc.searchParams.get("code"), "正确令牌批准后带 code + state 回跳");

const tokenReq = (params) => fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
const badPkce = await tokenReq({ grant_type: "authorization_code", code: loc.searchParams.get("code"), code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-123", client_id: reg.client_id, redirect_uri: redirect });
ok(badPkce.status === 400, "PKCE 校验失败被拒");
const tk = await (await tokenReq({ grant_type: "authorization_code", code: loc.searchParams.get("code"), code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect })).json();
ok(tk.access_token && tk.refresh_token, "换取访问令牌与刷新令牌");

const t = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + tk.access_token } } });
const c = new Client({ name: "claude-ai-sim", version: "1" }); await c.connect(t);
const r = await c.callTool({ name: "today", arguments: {} });
ok(r.content[0].text.includes("attention"), "用 OAuth 令牌调用 MCP today");
await c.close();
const ev = await (await fetch(BASE + "/api/events?limit=5", { headers: { Authorization: "Bearer " + TOKEN } })).json();
ok(ev.some((e) => e.agent === "claude-ai"), "事件来源记为 claude-ai");

const rt = await (await tokenReq({ grant_type: "refresh_token", refresh_token: tk.refresh_token, client_id: reg.client_id })).json();
ok(rt.access_token && rt.refresh_token !== tk.refresh_token, "刷新令牌轮换");
const reuse = await tokenReq({ grant_type: "refresh_token", refresh_token: tk.refresh_token, client_id: reg.client_id });
ok(reuse.status === 400 && (await reuse.json()).error === "invalid_grant", "旧刷新令牌作废（invalid_grant）");
const apiWithOauth = await fetch(BASE + "/api/tasks", { headers: { Authorization: "Bearer " + rt.access_token } });
ok(apiWithOauth.status === 200, "OAuth 令牌也能读 REST API");

hub.kill(); fs.rmSync(dir, { recursive: true, force: true });
console.log("OAuth 流程全部通过");
