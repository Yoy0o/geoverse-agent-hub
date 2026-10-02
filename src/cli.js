// 命令行：node src/cli.js <import 备份.json | export [文件] | token | stats | sync [--dry-run]>
import fs from "node:fs";
import { config } from "#hub/config";
import { stats, listDocs } from "#hub/db";
import { importBackup } from "./api.js";
import { getConfig } from "./domain.js";

const [cmd, arg] = process.argv.slice(2);
if (cmd === "import") {
  if (!arg) { console.error("用法：node src/cli.js import <备份.json>"); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(arg, "utf8"));
  if (data.app !== "agent-workbench") { console.error("不是 Agent 工作台的备份文件（缺少 app: agent-workbench）"); process.exit(1); }
  console.log("已导入", importBackup(data, "cli"));
} else if (cmd === "export") {
  const out = { app: "agent-workbench", version: 1, exportedAt: new Date().toISOString(), config: getConfig(),
    tasks: listDocs("tasks").map((x) => ({ ...x.data, id: x.id })), rules: listDocs("rules").map((x) => ({ ...x.data, id: x.id })), retros: listDocs("retros").map((x) => ({ ...x.data, id: x.id })) };
  const s = JSON.stringify(out, null, 2);
  if (arg) { fs.writeFileSync(arg, s); console.log("已导出到", arg); } else process.stdout.write(s + "\n");
} else if (cmd === "token") {
  console.log(config.token);
} else if (cmd === "stats") {
  console.log(stats());
} else if (cmd === "sync") {
  // 与 HUB_SYNC_URL 指定的对端同步一轮（在 Hub 所在的容器里运行，读写的是这台 Hub 的数据库）
  const { syncNow } = await import("./sync.js");
  try {
    const r = await syncNow({ dryRun: process.argv.includes("--dry-run") });
    if (r.dryRun) console.log(`预览（未写入）：对端「${r.peer.name}」 拉取 ${r.pull} · 推送 ${r.push} · 冲突 ${r.conflicts.length}`, r.conflicts.length ? r.conflicts : "");
    else console.log(`已与「${r.peer.name}」同步：拉取 ${r.pulled} · 推送 ${r.pushed} · 合并冲突 ${r.conflicts}${r.rejected ? " · 下一轮重试 " + r.rejected : ""}`);
  } catch (e) { console.error("同步失败：" + e.message); process.exit(1); }
} else {
  console.log("用法：node src/cli.js <import 备份.json | export [文件] | token | stats | sync [--dry-run]>");
}
process.exit(0);
