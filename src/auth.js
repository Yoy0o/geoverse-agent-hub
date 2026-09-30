// 鉴权：本机 Agent / 脚本用 Bearer 令牌；网页用登录后的 HttpOnly Cookie；claude.ai 连接器走 OAuth（见 oauth.js）
import crypto from "node:crypto";
import { config } from "#hub/config";
import { kv, bus } from "#hub/db";

const COOKIE = "hub_session";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sessionKey = (value) => "auth:session:" + hash(value);

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* malformed cookie is unauthenticated */ } }
  });
  return out;
}
export function bearer(req) {
  const h = String(req.headers.authorization || "");
  if (/^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, "").trim();
  if (req.headers["x-hub-token"]) return String(req.headers["x-hub-token"]).trim();
  return "";
}
// 返回 {via:'token'|'cookie'|'oauth', ...} 或 null
export async function identify(req, oauthVerifier) {
  const b = bearer(req);
  if (b) {
    if (safeEqual(b, config.token)) return { via: "token" };
    if (oauthVerifier) { try { const info = await oauthVerifier.verifyAccessToken(b); if (info) return { via: "oauth", info }; } catch { /* 无效 */ } }
    return null;
  }
  const c = cookies(req)[COOKIE];
  if (c) {
    const session = kv.get(sessionKey(c));
    if (session && session.expiresAt > Date.now() && safeEqual(session.tokenHash, hash(config.token))) return { via: "cookie", sessionHash: hash(c), expiresAt: session.expiresAt };
  }
  return null;
}
// 需要登录；Cookie 方式的写请求还要求自定义头（防 CSRF）
export function requireAuth(oauthVerifier) {
  return async (req, res, next) => {
    const who = await identify(req, oauthVerifier);
    if (!who) return res.status(401).json({ error: "unauthorized", hint: "Authorization: Bearer <HUB_TOKEN>" });
    if (who.via === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-requested-with"] !== "agent-hub") {
      return res.status(403).json({ error: "csrf" });
    }
    req.who = who;
    next();
  };
}

export function loginRoutes(app) {
  app.post("/api/login", (req, res) => {
    const key = "auth:attempts:" + hash(req.ip || "?"); const a = kv.get(key) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 20) return res.status(429).json({ error: "too_many_attempts" });
    const token = String((req.body && req.body.token) || "").trim();
    if (!safeEqual(token, config.token)) { a.n++; kv.set(key, a, 15 * 60000); return res.status(401).json({ error: "bad_token" }); }
    kv.del(key);
    const value = crypto.randomBytes(32).toString("base64url");
    const ttl = config.sessionTtlSeconds;
    kv.set(sessionKey(value), { tokenHash: hash(config.token), expiresAt: Date.now() + ttl * 1000 }, ttl * 1000);
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${config.cookieSecure ? "; Secure" : ""}`);
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    const value = cookies(req)[COOKIE];
    if (value && req.headers["x-requested-with"] !== "agent-hub") return res.status(403).json({ error: "csrf" });
    if (value) { kv.del(sessionKey(value)); bus.emit("auth-revoked", hash(value)); }
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure ? "; Secure" : ""}`);
    res.json({ ok: true });
  });
}
