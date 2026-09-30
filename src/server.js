// agent-hub 入口
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { pruneEvents, kv, getDoc, setDoc } from "./db.js";
import { requireAuth, identify, loginRoutes } from "./auth.js";
import { apiRoutes } from "./api.js";
import { hookRoutes } from "./hooks.js";
import { mcpRoutes } from "./mcp.js";
import { DEFAULT_AGENTS } from "./domain.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
app.disable("x-powered-by");
if (config.publicUrl || process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));

// 初次启动：写入默认配置
if (!getDoc("config", "main")) setDoc("config", "main", { agents: DEFAULT_AGENTS.slice(), projects: [] }, "hub");

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
  req.who = who; next();
};

// 钩子与遥测要在 JSON 解析之前挂（它们自己读原始请求体）
hookRoutes(app, auth);
app.use(express.json({ limit: "8mb" }));
loginRoutes(app);
mcpRoutes(app, mcpAuth);
apiRoutes(app, auth);

// 网页
app.use(express.static(path.join(ROOT, "public"), { index: "index.html", maxAge: "5m" }));
app.use((err, req, res, next) => {
  console.error("[error]", err && err.stack || err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.type === "entity.too.large" ? "payload_too_large" : "internal_error" });
});

setInterval(() => { try { pruneEvents(config.eventRetentionDays); kv.prune(); } catch (e) { console.error(e); } }, 6 * 3600 * 1000).unref();

app.listen(config.port, config.host, () => {
  const local = `http://127.0.0.1:${config.port}`;
  console.log(`agent-hub ${config.version} 已启动：${config.publicUrl || local}`);
  console.log(`  网页        ${config.publicUrl || local}/`);
  console.log(`  MCP         ${config.publicUrl || local}/mcp`);
  console.log(`  钩子 / OTel ${config.publicUrl || local}/hooks/<agent> · /v1/logs`);
  if (config.oauth) console.log(`  OAuth       已开启（claude.ai 自定义连接器地址：${config.publicUrl}/mcp）`);
  if (config.tokenGenerated) console.log(`\n  首次启动已生成访问令牌（保存在 ${path.join(config.dataDir, "hub-token")}）：\n  HUB_TOKEN=${config.token}\n`);
});
