import { current } from "./runtime.js";
import { syncConfig } from "../config-sync.js";

const num = (v, fallback) => v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback;
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || ""));

export function createConfig(env) {
  const publicUrl = String(env.PUBLIC_URL || "").replace(/\/+$/, "");
  let priceTable = {};
  try { priceTable = JSON.parse(env.PRICE_TABLE || "{}"); } catch { /* optional */ }
  return {
    token: String(env.HUB_TOKEN || "").trim(), tokenGenerated: false,
    publicUrl, oauth: bool(env.OAUTH_ENABLED) && !!publicUrl,
    cookieSecure: publicUrl.startsWith("https://"),
    sessionTtlSeconds: Math.max(1, Math.min(num(env.SESSION_TTL_SECONDS, 7 * 86400), 30 * 86400)),
    usdToCny: num(env.USD_CNY, 7.2), storePayload: String(env.HUB_STORE_PAYLOAD || "summary").toLowerCase(),
    eventRetentionDays: Math.max(1, num(env.EVENT_RETENTION_DAYS, 90)), priceTable, version: "0.2.0",
    hubName: String(env.HUB_NAME || "云端 Hub").trim().slice(0, 40), hubKind: env.HUB_KIND === "local" ? "local" : "cloud",
    runStallMinutes: Math.max(1, num(env.RUN_STALL_MINUTES, 15)), runnerOfflineSeconds: Math.max(15, num(env.RUNNER_OFFLINE_SECONDS, 90)),
    sync: syncConfig(env),
    llm: { provider: String(env.LLM_PROVIDER || "").toLowerCase(), apiKey: env.LLM_API_KEY || "", model: env.LLM_MODEL || "", baseUrl: String(env.LLM_BASE_URL || "").replace(/\/+$/, "") },
  };
}

export const config = new Proxy({}, { get: (_, key) => current().config[key] });
export function hubBaseUrl(req) {
  return config.publicUrl || `${req.protocol || "http"}://${req.headers.host}`;
}
