// 鉴权：本机 Agent / 脚本用 Bearer 令牌；网页用登录后的 HttpOnly Cookie；claude.ai 连接器走 OAuth（见 oauth.js）
import crypto from "node:crypto";
import { config } from "./config.js";

const COOKIE = "hub_session";
const sessionValue = () => crypto.createHmac("sha256", config.token).update("ui-session-v1").digest("base64url");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
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
  if (c && safeEqual(c, sessionValue())) return { via: "cookie" };
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

const attempts = new Map();
export function loginRoutes(app) {
  app.post("/api/login", (req, res) => {
    const ip = req.ip || "?"; const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 20) return res.status(429).json({ error: "too_many_attempts" });
    const token = String((req.body && req.body.token) || "").trim();
    if (!safeEqual(token, config.token)) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: "bad_token" }); }
    attempts.delete(ip);
    res.setHeader("Set-Cookie", `${COOKIE}=${sessionValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${config.cookieSecure ? "; Secure" : ""}`);
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure ? "; Secure" : ""}`);
    res.json({ ok: true });
  });
}
