// 运行配置：全部来自环境变量（docker compose 里的 .env）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const env = process.env;
const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v)));

const dataDir = path.resolve(env.HUB_DATA_DIR || "./data");
fs.mkdirSync(dataDir, { recursive: true });

// 访问令牌：优先用环境变量；没有就在数据目录生成一个并持久化
function loadToken() {
  if (env.HUB_TOKEN && env.HUB_TOKEN.trim()) return { token: env.HUB_TOKEN.trim(), generated: false };
  const f = path.join(dataDir, "hub-token");
  if (fs.existsSync(f)) return { token: fs.readFileSync(f, "utf8").trim(), generated: false };
  const t = "ah_" + crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(f, t + "\n", { mode: 0o600 });
  return { token: t, generated: true };
}
const tk = loadToken();

const publicUrl = (env.PUBLIC_URL || "").replace(/\/+$/, "");

export const config = {
  port: num(env.PORT, 8787),
  host: env.HOST || "0.0.0.0",
  dataDir,
  dbFile: path.join(dataDir, "agent-hub.db"),
  token: tk.token,
  tokenGenerated: tk.generated,
  // 对外地址：用于生成接入命令、OAuth（claude.ai 自定义连接器）。本机使用可以留空
  publicUrl,
  // 打开后 claude.ai / Cowork / Claude 手机端可以通过 OAuth 把 hub 加为自定义连接器（需要 HTTPS 的 PUBLIC_URL）
  oauth: bool(env.OAUTH_ENABLED, false) && !!publicUrl,
  cookieSecure: publicUrl.startsWith("https://"),
  sessionTtlSeconds: Math.max(1, Math.min(num(env.SESSION_TTL_SECONDS, 7 * 86400), 30 * 86400)),
  usdToCny: num(env.USD_CNY, 7.2),
  // 钩子载荷的存储方式：summary 只存摘要字段；full 存完整载荷（截断到 32KB）；none 不存载荷
  storePayload: (env.HUB_STORE_PAYLOAD || "summary").toLowerCase(),
  eventRetentionDays: num(env.EVENT_RETENTION_DAYS, 90),
  // 可选：给“让 Claude 解析 / 提炼规则 / 起草复盘”用的模型
  llm: {
    provider: (env.LLM_PROVIDER || "").toLowerCase(), // anthropic | openai（兼容接口，如 DeepSeek、通义、Kimi、本地 vLLM）
    apiKey: env.LLM_API_KEY || "",
    model: env.LLM_MODEL || "",
    baseUrl: (env.LLM_BASE_URL || "").replace(/\/+$/, ""),
  },
  // Codex 等只上报 token 数的 Agent，用它估算成本（美元 / 百万 token），例如 {"gpt-5.5":{"in":1.25,"out":10}}
  priceTable: (() => { try { return JSON.parse(env.PRICE_TABLE || "{}"); } catch { return {}; } })(),
  version: "0.1.0",
};

export function hubBaseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${config.port}`;
  return `${proto}://${host}`;
}
