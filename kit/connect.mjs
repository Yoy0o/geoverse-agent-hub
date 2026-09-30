#!/usr/bin/env node
// agent-hub 本机接入（每台电脑运行一次）：
//   node connect.mjs --url __HUB_URL__ --token <HUB_TOKEN> [--agents claude,codex,cursor,vscode,copilot,kiro,claude-desktop] [--no-otel] [--dry-run]
// 做四件事：
//   1. 写入 ~/.config/agent-hub/env（仓库里的 hub.sh 从这里读地址和令牌，权限 600）
//   2. 把 agent-hub 注册为各 Agent 的 MCP 服务器（用户级配置，改之前自动备份）
//   3. 给 Claude Code、Codex 打开 OTel 遥测，成本和 token 自动回传（--no-otel 跳过）
//   4. 检查连接
// 不传 --agents 时自动检测本机装了哪些 Agent。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const flag = (k) => args.includes("--" + k);
const HOME = os.homedir();
const DRY = flag("dry-run");
const OTEL = !flag("no-otel");
let URL_ = (opt("url", process.env.AGENT_HUB_URL || "__HUB_URL__") || "").replace(/\/+$/, "");
let TOKEN = opt("token", process.env.AGENT_HUB_TOKEN || "");
const CF_ID = opt("access-client-id", process.env.CF_ACCESS_CLIENT_ID || "");
const CF_SECRET = opt("access-client-secret", process.env.CF_ACCESS_CLIENT_SECRET || "");
const log = (...a) => console.log(...a);
const done = [];

function which(bin) { try { execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }); return true; } catch { return false; } }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function backup(p) { if (exists(p) && !DRY) fs.copyFileSync(p, p + ".bak-agent-hub-" + new Date().toISOString().replace(/[:.]/g, "-")); }
function writeFile(p, content, mode) {
  if (DRY) { log(`  [dry-run] 将写入 ${p}`); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true }); backup(p); fs.writeFileSync(p, content, mode ? { mode } : undefined);
}
function editJson(p, fn, label) {
  let obj = {};
  if (exists(p)) {
    const raw = fs.readFileSync(p, "utf8");
    try { obj = raw.trim() ? JSON.parse(raw) : {}; }
    catch { log(`  ! ${label}：${p} 不是纯 JSON（可能有注释），请手动加入下面的配置：`); const o = {}; fn(o); log(JSON.stringify(o, null, 2)); return false; }
  }
  fn(obj);
  writeFile(p, JSON.stringify(obj, null, 2) + "\n");
  done.push([label, p]); return true;
}
function tomlStr(s) { return JSON.stringify(String(s)); }
function removeTomlTable(text, header) {
  const lines = text.split("\n"); const out = []; let skip = false;
  for (const l of lines) {
    const h = l.match(/^\s*\[([^\]]+)\]\s*$/);
    if (h) skip = h[1].trim() === header;
    if (!skip) out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
const mcpUrl = (agent) => `${URL_}/mcp?agent=${agent}`;
const auth = () => ({ Authorization: "Bearer " + TOKEN, ...(CF_ID && CF_SECRET ? { "CF-Access-Client-Id": CF_ID, "CF-Access-Client-Secret": CF_SECRET } : {}) });
const tomlHeaders = () => "{ " + Object.entries(auth()).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(", ") + " }";
const vscodeUserDir = () => process.platform === "darwin" ? path.join(HOME, "Library/Application Support/Code/User")
  : process.platform === "win32" ? path.join(process.env.APPDATA || HOME, "Code/User") : path.join(HOME, ".config/Code/User");
const claudeDesktopConfig = () => process.platform === "darwin" ? path.join(HOME, "Library/Application Support/Claude/claude_desktop_config.json")
  : process.platform === "win32" ? path.join(process.env.APPDATA || HOME, "Claude/claude_desktop_config.json") : path.join(HOME, ".config/Claude/claude_desktop_config.json");

const AGENTS = {
  claude: {
    label: "Claude Code", detect: () => which("claude") || exists(path.join(HOME, ".claude")),
    run() {
      const cfg = { type: "http", url: mcpUrl("claude-code"), headers: auth() };
      if (which("claude")) {
        if (DRY) log("  [dry-run] claude mcp add-json -s user agent-hub …");
        else {
          try { execFileSync("claude", ["mcp", "remove", "agent-hub", "-s", "user"], { stdio: "ignore" }); } catch { /* 不存在 */ }
          execFileSync("claude", ["mcp", "add-json", "agent-hub", JSON.stringify(cfg), "-s", "user"], { stdio: "ignore" });
        }
        done.push(["Claude Code MCP", "claude mcp（用户级）"]);
      } else {
        editJson(path.join(HOME, ".claude.json"), (o) => { o.mcpServers = o.mcpServers || {}; o.mcpServers["agent-hub"] = cfg; }, "Claude Code MCP");
      }
      if (OTEL) editJson(path.join(HOME, ".claude/settings.json"), (o) => {
        o.env = Object.assign({}, o.env || {}, {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_ENDPOINT: URL_,
          OTEL_EXPORTER_OTLP_HEADERS: Object.entries(auth()).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(","), OTEL_LOGS_EXPORT_INTERVAL: "5000",
        });
      }, "Claude Code 遥测");
    },
  },
  codex: {
    label: "Codex", detect: () => which("codex") || exists(path.join(HOME, ".codex")),
    run() {
      const p = path.join(HOME, ".codex/config.toml");
      let t = exists(p) ? fs.readFileSync(p, "utf8") : "";
      t = removeTomlTable(t, "mcp_servers.agent-hub").trimEnd();
      t += `\n\n[mcp_servers.agent-hub]\nurl = ${tomlStr(mcpUrl("codex"))}\nhttp_headers = ${tomlHeaders()}\n`;
      let otelNote = "";
      if (OTEL) {
        if (/^\s*\[otel\]\s*$/m.test(t)) otelNote = "已有 [otel] 配置，未修改（要把成本回传 hub，把 exporter 指向 " + URL_ + "/v1/logs，protocol = \"json\"）";
        else t += `\n[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = ${tomlStr(URL_ + "/v1/logs")}, protocol = "json", headers = ${tomlHeaders()} } }\n`;
      }
      writeFile(p, t.replace(/^\n+/, ""));
      done.push(["Codex MCP" + (OTEL && !otelNote ? " + 遥测" : ""), p]);
      if (otelNote) log("  ! Codex：" + otelNote);
    },
  },
  cursor: {
    label: "Cursor", detect: () => exists(path.join(HOME, ".cursor")) || which("cursor") || which("cursor-agent"),
    run() { editJson(path.join(HOME, ".cursor/mcp.json"), (o) => { o.mcpServers = o.mcpServers || {}; o.mcpServers["agent-hub"] = { url: mcpUrl("cursor"), headers: auth() }; }, "Cursor MCP"); },
  },
  vscode: {
    label: "VS Code（Copilot 智能体模式）", detect: () => exists(vscodeUserDir()),
    run() { editJson(path.join(vscodeUserDir(), "mcp.json"), (o) => { o.servers = o.servers || {}; o.servers["agent-hub"] = { type: "http", url: mcpUrl("copilot"), headers: auth() }; }, "VS Code MCP"); },
  },
  copilot: {
    label: "Copilot CLI", detect: () => which("copilot") || exists(path.join(HOME, ".copilot")),
    run() { editJson(path.join(HOME, ".copilot/mcp-config.json"), (o) => { o.mcpServers = o.mcpServers || {}; o.mcpServers["agent-hub"] = { type: "http", url: mcpUrl("copilot"), headers: auth(), tools: ["*"] }; }, "Copilot CLI MCP"); },
  },
  kiro: {
    label: "Kiro", detect: () => exists(path.join(HOME, ".kiro")) || which("kiro") || which("kiro-cli"),
    run() { editJson(path.join(HOME, ".kiro/settings/mcp.json"), (o) => { o.mcpServers = o.mcpServers || {}; o.mcpServers["agent-hub"] = { url: mcpUrl("kiro"), headers: auth(), disabled: false, autoApprove: ["today", "list_tasks", "get_task", "get_project", "list_rules"] }; }, "Kiro MCP"); },
  },
  "claude-desktop": {
    label: "Claude 桌面版 / Cowork（本机，经 mcp-remote 桥接）", detect: () => false,
    run() {
      const local = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(URL_);
      const a = ["-y", "mcp-remote", mcpUrl("cowork"), "--header", "Authorization:${AGENT_HUB_AUTH}"];
      if (CF_ID && CF_SECRET) a.push("--header", "CF-Access-Client-Id:${CF_ACCESS_CLIENT_ID}", "--header", "CF-Access-Client-Secret:${CF_ACCESS_CLIENT_SECRET}");
      if (URL_.startsWith("http://") && !local) a.push("--allow-http");
      editJson(claudeDesktopConfig(), (o) => { o.mcpServers = o.mcpServers || {}; o.mcpServers["agent-hub"] = { command: "npx", args: a, env: { AGENT_HUB_AUTH: "Bearer " + TOKEN, ...(CF_ID && CF_SECRET ? { CF_ACCESS_CLIENT_ID: CF_ID, CF_ACCESS_CLIENT_SECRET: CF_SECRET } : {}) } }; }, "Claude 桌面版 MCP");
    },
  },
};

async function main() {
  if (!!CF_ID !== !!CF_SECRET) { console.error("Access Client ID 与 Secret 必须同时提供"); process.exit(1); }
  if (!URL_ || URL_.includes("__HUB" + "_URL__")) { console.error("缺少 --url，例如 --url http://127.0.0.1:8787"); process.exit(1); }
  if (!TOKEN) {
    if (!process.stdin.isTTY) { console.error("缺少 --token"); process.exit(1); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    TOKEN = (await rl.question("HUB_TOKEN（运行 node src/cli.js token 查看，或使用云端部署密钥）：")).trim(); rl.close();
  }
  log(`agent-hub：${URL_}${DRY ? "（dry-run，不会改任何文件）" : ""}`);
  try {
    const r = await fetch(URL_ + "/api/capabilities", { headers: auth() });
    if (r.status === 401) { console.error("令牌不对（401）"); process.exit(1); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    log("✓ 连接与令牌正常");
  } catch (e) { console.error("✗ 连不上 hub：" + e.message + "。先确认 hub 已启动、地址可达"); process.exit(1); }

  const envFile = path.join(HOME, ".config/agent-hub/env");
  if ([URL_, TOKEN, CF_ID, CF_SECRET].some(value => /[\r\n]/.test(value))) { console.error("连接配置不能包含换行"); process.exit(1); }
  writeFile(envFile, `AGENT_HUB_URL=${URL_}\nAGENT_HUB_TOKEN=${TOKEN}\nCF_ACCESS_CLIENT_ID=${CF_ID}\nCF_ACCESS_CLIENT_SECRET=${CF_SECRET}\n`, 0o600);
  if (!DRY) try { fs.chmodSync(envFile, 0o600); } catch { /* Windows */ }
  done.push(["仓库脚本读取的连接配置", envFile]);

  const want = opt("agents", "");
  const list = want ? want.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(AGENTS).filter((k) => AGENTS[k].detect());
  if (!list.length) log("没有检测到已安装的 Agent；可以用 --agents 指定");
  for (const k of list) {
    const a = AGENTS[k]; if (!a) { log("  ? 未知 Agent：" + k); continue; }
    log("· " + a.label);
    try { a.run(); } catch (e) { log("  ! 失败：" + e.message); }
  }
  log("\n已完成：");
  done.forEach(([l, p]) => log(`  ${l.padEnd(22)} ${p}`));
  log(`\n下一步：
  1. 重启已打开的 Agent（MCP 与遥测配置在启动时加载）
  2. 在工作台“项目”页下载接入包，运行 bash agent-kit-<项目>/install.sh <项目目录>
  3. 让任意 Agent 调用 agent-hub 的 today 工具试试（例如在 Claude Code 里说“用 agent-hub 看看今天要处理什么”）
  配置文件改动前都有备份（*.bak-agent-hub-时间戳）。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
