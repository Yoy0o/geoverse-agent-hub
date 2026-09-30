// 命令行：node src/cli.js <import 备份.json | export [文件] | token | stats>
import fs from "node:fs";
import { config } from "./config.js";
import { stats, listDocs } from "./db.js";
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
} else {
  console.log("用法：node src/cli.js <import 备份.json | export [文件] | token | stats>");
}
process.exit(0);
