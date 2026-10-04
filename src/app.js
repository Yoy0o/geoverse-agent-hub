// agent-hub 入口
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "#hub/config";
import { pruneEvents, kv, getDoc, setDoc } from "#hub/db";
import { requireAuth, identify, loginRoutes } from "./auth.js";
import { apiRoutes } from "./api.js";
import { hookRoutes } from "./hooks.js";
import { mcpRoutes } from "./mcp.js";
import { DEFAULT_AGENTS } from "./domain.js";
import { wireExec } from "./exec.js";
import { retiredTo, retiredHint } from "./retire.js";
import { sessionStartResponse, kindOf } from "./ingest.js";


export async function createApp({ serveStatic = true, trustProxy = 0 } = {}) {
  const ROOT = serveStatic ? path.join(path.dirname(fileURLToPath(import.meta.url)), "..") : null;
  const app = express();
  app.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store").set("Referrer-Policy", "no-referrer").set("X-Content-Type-Options", "nosniff");
    next();
  });
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", trustProxy);

  // 初次启动：写入默认配置
  if (!getDoc("config", "main")) setDoc("config", "main", { agents: DEFAULT_AGENTS.slice(), projects: [] }, "hub");
  // 任务文档的变化（网页、MCP、钩子、对端同步）→ 收尾对应的执行记录
  wireExec();

  let oauthProvider = null;
  if (config.oauth) {
    const { oauthRoutes, provider } = await import("./oauth.js");
    oauthProvider = provider;
    oauthRoutes(app);
  }
  const auth = requireAuth(oauthProvider);
  // /mcp 未授权时按 MCP 规范返回 401 + resource_metadata，claude.ai 据此发起 OAuth
  const mcpAuth = async (req, res, next) => {
    const who = await identify(req, oauthProvider);
    if (!who) {
      if (config.oauth) res.set("WWW-Authenticate", `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
      return res.status(401).json({ error: "unauthorized" });
    }
    if (who.via === "cookie" && req.headers["x-requested-with"] !== "agent-hub") return res.status(403).json({ error: "csrf" });
    req.who = who; next();
  };

  // 已停用（云端唯一）：已登录的写请求一律返回 410 并给出云端地址；会话开始的钩子把切换提示交给 Agent。
  // 读接口、登录、从云端拉取的同步继续可用；MCP 在工具层面只保留只读工具
  app.use(async (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || /^\/api\/(login|logout|sync\/run)$/.test(req.path) || req.path === "/mcp") return next();
    const to = retiredTo();
    if (!to) return next();
    if (!(await identify(req, oauthProvider))) return next();
    const hint = retiredHint(to);
    const hook = req.path.match(/^\/hooks\/([a-z0-9-]+)$/i);
    if (hook && kindOf(String(req.query.event || "")) === "session.start") {
      const out = sessionStartResponse(hook[1].toLowerCase(), "【agent-hub】" + hint);
      return out.type === "text" ? res.type("text/plain; charset=utf-8").send(out.body) : res.json(out.body);
    }
    res.status(410).json({ error: "retired", hint, retiredTo: to });
  });

  // 钩子与遥测要在 JSON 解析之前挂（它们自己读原始请求体）
  hookRoutes(app, auth);
  app.use(express.json({ limit: "8mb" }));
  loginRoutes(app);
  mcpRoutes(app, mcpAuth);
  apiRoutes(app, auth);

  // 网页
  if (serveStatic) app.use(express.static(path.join(ROOT, "public"), { index: "index.html", maxAge: "5m" }));
  app.use((err, req, res, next) => {
    console.error("[error]", err && err.stack || err);
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: err.type === "entity.too.large" ? "payload_too_large" : err.type === "entity.parse.failed" ? "bad_json" : status < 500 && err.expose ? err.message : "internal_error" });
  });


  return app;
}
