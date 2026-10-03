import { config } from "#hub/config";
import { pruneEvents, pruneRuns, kv } from "#hub/db";
import { syncNow } from "./sync.js";
import { createApp } from "./app.js";

const app = await createApp({ trustProxy: config.publicUrl || process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY || 1) : 0 });

setInterval(() => { try { pruneEvents(config.eventRetentionDays); pruneRuns(config.eventRetentionDays); kv.prune(); } catch (e) { console.error(e); } }, 6 * 3600 * 1000).unref();

// 多端同步：配置了 HUB_SYNC_URL 时定时与对端同步（失败只记日志，下一轮重试）
if (config.sync.url && config.sync.token && config.sync.interval > 0) {
  const tick = () => syncNow().catch((e) => console.error("[sync]", e.message));
  setTimeout(tick, 3000).unref();
  setInterval(tick, config.sync.interval * 1000).unref();
}

app.listen(config.port, config.host, () => {
  const local = `http://127.0.0.1:${config.port}`;
  console.log(`agent-hub ${config.version} 已启动：${config.publicUrl || local}`);
  console.log(`  网页        ${config.publicUrl || local}/`);
  console.log(`  MCP         ${config.publicUrl || local}/mcp`);
  console.log(`  钩子 / OTel ${config.publicUrl || local}/hooks/<agent> · /v1/logs`);
  if (config.oauth) console.log(`  OAuth       已开启（claude.ai 自定义连接器地址：${config.publicUrl}/mcp）`);
  if (config.sync.url) console.log(`  多端同步    ${config.sync.url}（${config.sync.mode}，${config.sync.interval ? "每 " + config.sync.interval + " 秒" : "仅手动"}）`);
  if (config.tokenGenerated) console.log(`  首次启动已生成访问令牌，请运行 node src/cli.js token 查看。`);
});
