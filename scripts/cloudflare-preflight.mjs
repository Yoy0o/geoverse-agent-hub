import { pathToFileURL } from "node:url";
import path from "node:path";

// Offline configuration checks. Authentication, Access policies and remote Secrets
// must also be verified in the Cloudflare account before opening the service.
export function deploymentErrors(config, { bootstrap = false } = {}) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const vars = config.vars || {};
  const list = value => String(value || "").split(",").map(v => v.trim()).filter(Boolean);
  check(/^[a-f0-9]{32}$/.test(config.account_id || ""), "需要明确的 Cloudflare account_id。");
  check(config.preview_urls === false, "必须关闭 preview_urls。");
  check(config.assets?.run_worker_first === true && config.assets?.binding === "ASSETS", "静态资源必须先通过 Worker 的身份校验。");
  check(!("LOCAL_DEV" in vars), "云端 vars 不应包含 LOCAL_DEV。");
  check(!Object.keys(vars).some(key => /(?:TOKEN|SECRET|API_KEY|PASSWORD)$/.test(key)), "密钥必须使用 Secret，不能放在 vars 中。");
  check(config.secrets?.required?.includes("HUB_TOKEN"), "必须声明 HUB_TOKEN 为 required Secret。");
  check(typeof vars.HUB_INSTANCE === "string" && vars.HUB_INSTANCE.trim().length > 0, "需要稳定的 HUB_INSTANCE。");
  check(String(vars.OAUTH_ENABLED) === "0", "私人部署准备默认保持 OAUTH_ENABLED=0。");
  const emails = list(vars.ACCESS_ALLOWED_EMAILS);
  check(emails.length > 0 && emails.every(email => /^[^\s@*,]+@[^\s@*,]+\.[^\s@*,]+$/.test(email)), "需要明确的 Access 邮箱白名单。");
  check(/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(vars.ACCESS_TEAM_DOMAIN || ""), "需要 Access 团队域名，不包含 https://。");
  check(config.durable_objects?.bindings?.some(binding => binding.name === "HUB" && binding.class_name === "AgentHub"), "需要 HUB / AgentHub Durable Object 绑定。");
  check(config.migrations?.some(migration => migration.new_sqlite_classes?.includes("AgentHub")), "需要 AgentHub SQLite migration 历史。");
  const routes = config.routes || [];
  if (bootstrap) {
    check(config.workers_dev === false && routes.length === 0 && !config.route, "bootstrap 必须关闭 workers.dev，并且不绑定任何 route。");
    check(!vars.PUBLIC_URL && !vars.ACCESS_AUD, "bootstrap 必须保留空 PUBLIC_URL 与 ACCESS_AUD，确保应用拒绝云端请求。");
  } else {
    const audiences = list(vars.ACCESS_AUD);
    check(audiences.length > 0 && audiences.every(aud => /^[a-f0-9]{64}$/.test(aud)), "请填写 Access 应用实际的 64 位十六进制 AUD。");
    let origin;
    try { origin = new URL(vars.PUBLIC_URL); } catch { /* explained below */ }
    const validOrigin = origin && origin.protocol === "https:" && origin.origin === vars.PUBLIC_URL && !origin.username && !origin.password && !origin.port;
    check(validOrigin, "PUBLIC_URL 必须是完整 HTTPS origin，例如 https://geoverse-agent-hub.<账户子域>.workers.dev，不带尾斜杠。");
    if (validOrigin) {
      if (origin.hostname.endsWith(".workers.dev")) {
        check(new RegExp(`^${config.name}\\.[a-z0-9-]+\\.workers\\.dev$`).test(origin.hostname), "workers.dev 地址必须对应当前 Worker 名及真实账户子域。");
        check(config.workers_dev === true, "使用 workers.dev 入口时需要 workers_dev=true。");
        check(routes.length === 0 && !config.route, "workers.dev 方案请保持 routes 为空。");
      } else {
        check(config.workers_dev === false, "自定义域名方案保持 workers_dev=false。");
        check(routes.some(route => typeof route === "object" && route.custom_domain === true && route.pattern === origin.hostname), "PUBLIC_URL 必须对应 routes 中的 Custom Domain。");
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const bootstrap = process.argv.includes("--bootstrap");
  const { unstable_readConfig } = await import("wrangler");
  const config = unstable_readConfig({ config: "wrangler.jsonc" });
  const errors = deploymentErrors(config, { bootstrap });
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id) errors.push("CLOUDFLARE_ACCOUNT_ID 与配置账户不一致。");
  if (errors.length) {
    console.error("Cloudflare 配置未就绪：\n" + errors.map(error => "- " + error).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(bootstrap ? "bootstrap 配置检查通过：入口关闭，应用拒绝云端请求。" : "生产配置检查通过；仍需在云端确认 Access 策略、登录账户和 Secret。");
  }
}
