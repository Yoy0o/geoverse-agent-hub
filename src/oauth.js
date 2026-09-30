// 可选：OAuth 2.1 授权服务器（动态客户端注册 + PKCE），让 claude.ai / Cowork / Claude 手机端把 hub 加为“自定义连接器”。
// 授权页要求输入 HUB_TOKEN，只有知道令牌的人能批准。令牌只存哈希。
import crypto from "node:crypto";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { kv } from "./db.js";
import { config } from "./config.js";
import { safeEqual } from "./auth.js";

const H = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const rnd = (n = 32) => crypto.randomBytes(n).toString("base64url");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ACCESS_TTL = 24 * 3600, REFRESH_TTL = 90 * 24 * 3600;

const clientsStore = {
  async getClient(id) { return kv.get("oauth:client:" + id) || undefined; },
  async registerClient(client) { kv.set("oauth:client:" + client.client_id, client); return client; },
};

function issue(clientId, scopes, resource) {
  const at = "hat_" + rnd(), rt = "hrt_" + rnd();
  const base = { clientId, scopes: scopes || [], resource: resource ? String(resource) : undefined };
  kv.set("oauth:at:" + H(at), Object.assign({ exp: Math.floor(Date.now() / 1000) + ACCESS_TTL }, base), ACCESS_TTL * 1000);
  kv.set("oauth:rt:" + H(rt), base, REFRESH_TTL * 1000);
  return { access_token: at, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: rt, scope: (scopes || []).join(" ") };
}

export const provider = {
  get clientsStore() { return clientsStore; },
  async authorize(client, params, res) {
    const rid = rnd(18);
    kv.set("oauth:pending:" + rid, { clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, state: params.state || null, scopes: params.scopes || [], resource: params.resource ? String(params.resource) : null }, 10 * 60000);
    res.set("X-Frame-Options", "DENY").set("Cache-Control", "no-store").type("html").send(consentPage(client, params.redirectUri, rid, ""));
  },
  async challengeForAuthorizationCode(client, code) {
    const c = kv.get("oauth:code:" + H(code));
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("invalid authorization code");
    return c.codeChallenge;
  },
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const key = "oauth:code:" + H(code); const c = kv.get(key); kv.del(key);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("invalid authorization code");
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    return issue(client.client_id, c.scopes, c.resource);
  },
  async exchangeRefreshToken(client, refreshToken, scopes) {
    const key = "oauth:rt:" + H(refreshToken); const r = kv.get(key);
    if (!r || r.clientId !== client.client_id) throw new InvalidGrantError("invalid refresh token");
    kv.del(key); // 轮换
    return issue(client.client_id, scopes && scopes.length ? scopes : r.scopes, r.resource);
  },
  async verifyAccessToken(token) {
    const r = kv.get("oauth:at:" + H(token));
    if (!r) throw new InvalidTokenError("invalid token");
    return { token, clientId: r.clientId, scopes: r.scopes || [], expiresAt: r.exp, resource: r.resource ? new URL(r.resource) : undefined };
  },
  async revokeToken(client, req) {
    kv.del("oauth:at:" + H(req.token)); kv.del("oauth:rt:" + H(req.token));
  },
};

function consentPage(client, redirectUri, rid, error) {
  let host = ""; try { host = new URL(redirectUri).host; } catch { host = redirectUri; }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 agent-hub</title>
<style>:root{--bg:#F2F5F4;--s:#fff;--ink:#12201C;--mut:#5E706B;--acc:#0B6E66;--line:#D3DDDA;--bad:#B42318}
@media (prefers-color-scheme:dark){:root{--bg:#0D1412;--s:#141D1B;--ink:#E3ECE9;--mut:#8C9E99;--acc:#4DC1B4;--line:#2A3834;--bad:#F07A6F}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.box{background:var(--s);border:1px solid var(--line);border-radius:14px;padding:22px;max-width:420px;width:100%}h1{font-size:18px;margin:0 0 8px}p{margin:6px 0;color:var(--mut);font-size:14px}
b{color:var(--ink)}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;margin:12px 0}
button{width:100%;padding:10px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}.err{color:var(--bad)}</style></head>
<body><form class="box" method="post" action="/oauth/approve"><h1>授权访问 agent-hub</h1>
<p><b>${esc(client.client_name || "未命名客户端")}</b> 请求读写你的任务、规则和评审记录。</p>
<p>授权完成后会跳转到：<b>${esc(host)}</b></p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<input type="password" name="token" placeholder="输入 HUB_TOKEN 以批准" autocomplete="current-password" required autofocus>
<input type="hidden" name="rid" value="${esc(rid)}"><button type="submit">批准</button>
<p>不认识这个请求就关闭本页。</p></form></body></html>`;
}

export function oauthRoutes(app) {
  const base = new URL(config.publicUrl + "/");
  app.use(mcpAuthRouter({
    provider, issuerUrl: base, baseUrl: base, resourceServerUrl: new URL(config.publicUrl + "/mcp"),
    resourceName: "agent-hub", scopesSupported: ["hub"],
  }));
  const tries = new Map();
  app.post("/oauth/approve", express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    const rid = String(req.body.rid || ""); const p = kv.get("oauth:pending:" + rid);
    if (!p) return res.status(400).type("text/plain").send("授权请求已过期，请回到 Claude 重新连接。");
    const n = (tries.get(rid) || 0) + 1; tries.set(rid, n);
    if (!safeEqual(String(req.body.token || "").trim(), config.token)) {
      if (n >= 5) { kv.del("oauth:pending:" + rid); return res.status(429).type("text/plain").send("尝试次数过多，请重新发起连接。"); }
      return clientsStore.getClient(p.clientId).then((c) => res.status(401).set("X-Frame-Options", "DENY").type("html").send(consentPage(c || {}, p.redirectUri, rid, "令牌不对")));
    }
    kv.del("oauth:pending:" + rid); tries.delete(rid);
    const code = rnd(24);
    kv.set("oauth:code:" + H(code), { clientId: p.clientId, codeChallenge: p.codeChallenge, redirectUri: p.redirectUri, scopes: p.scopes, resource: p.resource }, 10 * 60000);
    const u = new URL(p.redirectUri); u.searchParams.set("code", code); if (p.state) u.searchParams.set("state", p.state);
    res.redirect(302, u.href);
  });
}

export const resourceMetadataUrl = () => config.publicUrl + "/.well-known/oauth-protected-resource/mcp";
