// 命令行：node src/cli.js <import 备份.json | export [文件] | token | stats | sync [--dry-run] | retire <云端地址> [--force] | retire --undo>
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
} else if (cmd === "retire") {
  // 云端唯一：先与云端做最后一次同步，确认本地修改都已推送，再把本 Hub 退役为只读
  const { syncNow, pendingLocal } = await import("./sync.js");
  const { retiredTo, setRetired } = await import("./retire.js");
  const force = process.argv.includes("--force");
  if (arg === "--undo") { setRetired(""); console.log("已恢复为可写的 Hub。"); process.exit(0); }
  let to = String(arg || "").replace(/\/+$/, "");
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(to);
  if (!/^https:\/\/[^/\s]+$/.test(to) && !loopback && !(force && /^https?:\/\/[^/\s]+$/.test(to))) { console.error("用法：node src/cli.js retire https://<云端 Hub 地址> [--force]   ·   撤销：node src/cli.js retire --undo"); process.exit(1); }
  if (!force) {
    if (!config.sync.url || !config.sync.token) { console.error("没有配置 HUB_SYNC_*，无法确认本地数据已经到了云端。\n先在 .env 配置 HUB_SYNC_URL / HUB_SYNC_TOKEN（及 Access 服务凭证）后重启再运行；或者导出 JSON 在云端导入后加 --force。"); process.exit(1); }
    if (new URL(config.sync.url).origin !== new URL(to).origin) { console.error(`同步对端是 ${config.sync.url}，与 ${to} 不一致。`); process.exit(1); }
    if (config.sync.mode === "pull") { console.error("同步方式是 pull（只拉取），本地修改从未推送到云端。改成 both 或 push 同步一次后再停用。"); process.exit(1); }
    try {
      const r = await syncNow();
      console.log(`最后一次同步完成：拉取 ${r.pulled} · 推送 ${r.pushed}${r.conflicts ? " · 合并冲突 " + r.conflicts : ""}`);
    } catch (e) { console.error("同步失败，未停用：" + e.message); process.exit(1); }
    const p = pendingLocal();
    if (p.changes || p.retry) { console.error(`还有 ${p.changes} 个本地修改未推送、${p.retry} 个被云端拒收待重试：再运行一次 sync，确认为 0 后再停用。`); process.exit(1); }
  }
  setRetired(to);
  console.log(`本 Hub 已停用为只读，数据以 ${to} 为准${retiredTo() === to ? "" : "（HUB_RETIRED_TO 环境变量优先）"}。
接下来在每台电脑上：
  1. node connect.mjs --url ${to} --name agent-hub          # 默认连接改为云端（带 Access 服务凭证）
  2. node connect.mjs --remove agent-hub-local                # 删除各 Agent 里指向本地 Hub 的 MCP
  3. node runner.mjs register --name <名称> --project …       # 执行端改连云端（如果用了执行端）
不再需要本地 Hub 时：docker compose stop agent-hub（数据卷保留，可随时只读查阅）。`);
} else {
  console.log("用法：node src/cli.js <import 备份.json | export [文件] | token | stats | sync [--dry-run] | retire <云端地址> [--force] | retire --undo>");
}
process.exit(0);
