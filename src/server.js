import { config } from "#hub/config";
import { pruneEvents, kv } from "#hub/db";
import { createApp } from "./app.js";

const app = await createApp({ trustProxy: config.publicUrl || process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY || 1) : 0 });

setInterval(() => { try { pruneEvents(config.eventRetentionDays); kv.prune(); } catch (e) { console.error(e); } }, 6 * 3600 * 1000).unref();

app.listen(config.port, config.host, () => {
  const local = `http://127.0.0.1:${config.port}`;
  console.log(`agent-hub ${config.version} 已启动：${config.publicUrl || local}`);
  console.log(`  网页        ${config.publicUrl || local}/`);
  console.log(`  MCP         ${config.publicUrl || local}/mcp`);
  console.log(`  钩子 / OTel ${config.publicUrl || local}/hooks/<agent> · /v1/logs`);
  if (config.oauth) console.log(`  OAuth       已开启（claude.ai 自定义连接器地址：${config.publicUrl}/mcp）`);
  if (config.tokenGenerated) console.log(`  首次启动已生成访问令牌，请运行 node src/cli.js token 查看。`);
});
