// 接入包生成：项目级（AGENTS.md、各 Agent 钩子配置、脚本、git 钩子）+ 本机级（connect.mjs）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { lines, relevantRules, RECEIPT_TEMPLATE } from "./domain.js";

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "kit");
const tpl = (f) => fs.readFileSync(path.join(KIT, f), "utf8");
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const fileSafe = (s) => String(s || "").replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
const J = (o) => JSON.stringify(o, null, 2) + "\n";

export function agentsMd(p) {
  const d = new Date(); const L = [];
  L.push("# AGENTS.md · " + p.name, "", "> 由 agent-hub 生成于 " + d.toLocaleDateString("zh-CN") + "。通用规则在工作台“规则库”维护后重新生成；项目特有内容可以直接编辑本文件。", "");
  L.push("## 项目概览"); if (p.stack) L.push("- 技术栈：" + p.stack); L.push("- 阶段：" + (p.stage || "开发中")); if (p.docs) L.push("- 设计文档：" + p.docs); L.push("");
  L.push("## 统一验证", "提交前、结束任务前必须运行并通过：", "", "```", "bash scripts/agent/verify.sh", "```", "");
  const v = lines(p.verify); v.length ? (L.push("它依次执行："), v.forEach((c) => L.push("- `" + c + "`"))) : L.push("尚未配置验证命令；至少运行项目自带的构建和测试，并在回执中写明。"); L.push("");
  const inv = lines(p.invariants); if (inv.length) { L.push("## 不可破坏的约束"); inv.forEach((x) => L.push("- " + x)); L.push(""); }
  L.push("## 禁区"); lines(p.forbidden).forEach((x) => L.push("- " + x));
  const pr = lines(p.protect); if (pr.length) L.push("- 受保护路径（修改会被拦截）：" + pr.map((x) => "`" + x + "`").join("、"));
  L.push("- 不读取、不输出、不提交 .env、密钥、证书等敏感文件", "- 不通过修改或删除测试让检查变绿", "");
  L.push("## 任务与 agent-hub",
    "- 每个任务在独立分支 `agent/<任务编号>-<简述>` 和独立 worktree 中进行；不要切换、合并或删除分支",
    "- 任务单在 `specs/<任务编号>.md`（task.sh start 自动写入；会话开始时钩子也会注入）。能用 agent-hub MCP 时，可以用 `get_task` 读取最新任务单",
    "- 按任务单的验收标准和“允许修改”范围工作；需要改范围外的文件时先停下来说明",
    "- 需要人决定的问题：结束本轮，在回执里写 `status: blocked` 并说明",
    "- 提交信息末尾带 `Task: <任务编号>`（git 钩子会自动补上）",
    "- 结束时：运行统一验证 → 输出交付回执 → 能用 agent-hub MCP 时调用 `submit_receipt` 提交同样内容", "");
  const rs = relevantRules(p.name); if (rs.length) { L.push("## 规则（来自工作台规则库）"); rs.forEach((r) => L.push("- " + r.text)); L.push(""); }
  L.push(RECEIPT_TEMPLATE, "");
  return L.join("\n");
}

const HUB = 'bash "$CLAUDE_PROJECT_DIR/scripts/agent/';
const claudeSettings = () => J({
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: HUB + 'hub.sh" report claude-code SessionStart', timeout: 10 }] }],
    PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: HUB + 'guard.sh" claude-code', timeout: 10 }] }],
    PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command: HUB + 'hub.sh" report claude-code PostToolUse', timeout: 10 }] }],
    Stop: [{ hooks: [
      { type: "command", command: HUB + 'stop-verify.sh" claude-code', timeout: 900 },
      { type: "command", command: HUB + 'hub.sh" report claude-code Stop', timeout: 10 }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: HUB + 'hub.sh" report claude-code SessionEnd', timeout: 10 }] }],
  },
});
const R = 'bash "$(git rev-parse --show-toplevel)/scripts/agent/';
const codexHooks = () => J({
  description: "agent-hub：任务单注入、受保护路径拦截、结束前统一验证、事件与回执上报",
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: R + 'hub.sh" report codex SessionStart', timeout: 10 }] }],
    PreToolUse: [{ matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: R + 'guard.sh" codex', timeout: 10 }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: R + 'hub.sh" report codex PostToolUse', timeout: 10, async: true }] }],
    Stop: [{ hooks: [
      { type: "command", command: R + 'stop-verify.sh" codex', timeout: 900 },
      { type: "command", command: R + 'hub.sh" report codex Stop', timeout: 10 }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: R + 'hub.sh" report codex SessionEnd', timeout: 10 }] }],
  },
});
const S = "bash scripts/agent/";
const cursorHooks = () => J({
  version: 1,
  hooks: {
    sessionStart: [{ command: S + "hub.sh report cursor sessionStart", timeout: 10 }],
    preToolUse: [{ command: S + "guard.sh cursor", matcher: "Write|Edit|MultiEdit|StrReplace|Delete", timeout: 10 }],
    afterFileEdit: [{ command: S + "hub.sh report cursor afterFileEdit", timeout: 10 }],
    afterShellExecution: [{ command: S + "hub.sh report cursor afterShellExecution", timeout: 10 }],
    afterAgentResponse: [{ command: S + "hub.sh report cursor afterAgentResponse", timeout: 10 }],
    stop: [{ command: S + "stop-verify.sh cursor", timeout: 900 }, { command: S + "hub.sh report cursor stop", timeout: 10 }],
    sessionEnd: [{ command: S + "hub.sh report cursor sessionEnd", timeout: 10 }],
  },
});
const copilotHooks = () => J({
  version: 1,
  hooks: {
    sessionStart: [{ type: "command", bash: S + "hub.sh report copilot sessionStart", timeoutSec: 10 }],
    preToolUse: [{ type: "command", bash: S + "guard.sh copilot", timeoutSec: 10 }],
    postToolUse: [{ type: "command", bash: S + "hub.sh report copilot postToolUse", timeoutSec: 10 }],
    agentStop: [{ type: "command", bash: S + "stop-verify.sh copilot", timeoutSec: 900 }, { type: "command", bash: S + "hub.sh report copilot agentStop", timeoutSec: 10 }],
    sessionEnd: [{ type: "command", bash: S + "hub.sh report copilot sessionEnd", timeoutSec: 10 }],
    errorOccurred: [{ type: "command", bash: S + "hub.sh report copilot errorOccurred", timeoutSec: 10 }],
  },
});
const kiroHooks = () => J({
  version: "v1",
  hooks: [
    { name: "agent-hub：会话开始注入任务单", trigger: "SessionStart", action: { type: "command", command: S + "hub.sh report kiro SessionStart" }, timeout: 10 },
    { name: "agent-hub：CLI 会话开始注入任务单", trigger: "AgentSpawn", action: { type: "command", command: S + "hub.sh report kiro AgentSpawn" }, timeout: 10 },
    { name: "agent-hub：拦截受保护路径", trigger: "PreToolUse", matcher: "write|fs_write|edit|create|str_replace|delete", action: { type: "command", command: S + "guard.sh kiro" }, timeout: 10 },
    { name: "agent-hub：记录文件修改", trigger: "PostFileSave", action: { type: "command", command: S + "hub.sh report kiro PostFileSave" }, timeout: 10 },
    { name: "agent-hub：结束前统一验证", trigger: "AgentStop", action: { type: "command", command: S + "stop-verify.sh kiro" }, timeout: 900 },
    { name: "agent-hub：回传事件与回执", trigger: "AgentStop", action: { type: "command", command: S + "hub.sh report kiro AgentStop" }, timeout: 10 },
    { name: "agent-hub：spec 任务完成", trigger: "PostTaskExecution", action: { type: "command", command: S + "hub.sh report kiro PostTaskExecution" }, timeout: 10 },
  ],
});
const KIRO_STEERING = [
  "---", "inclusion: always", "---", "",
  "# agent-hub 任务约定（Kiro 补充）", "",
  "通用规则见 AGENTS.md（Kiro 会自动加载）。这里只补充 Kiro 特有的部分：", "",
  "- 分支名 `agent/<任务编号>-…` 就是当前任务。开工先读 `specs/<任务编号>.md`，或调用 agent-hub MCP 的 `get_task`。",
  "- 用 Kiro spec 时，spec 目录命名为 `.kiro/specs/<任务编号>-<简述>/`，requirements.md 的验收标准与任务单保持一致，tasks.md 的每一项完成后勾选。",
  "- 结束时调用 agent-hub MCP 的 `submit_receipt` 提交交付回执，并在回复末尾输出 ```agent-receipt 代码块（Kiro 的结束钩子不一定带回复内容，MCP 提交更可靠）。", "",
].join("\n");

export function kitReadme(p, hubUrl) {
  return ["# " + p.name + " · agent-hub 接入包", "",
    "## 1. 本机连接 agent-hub（每台电脑一次）", "```",
    "curl -fsS " + hubUrl + "/connect.mjs -o /tmp/agent-hub-connect.mjs && node /tmp/agent-hub-connect.mjs --url " + hubUrl + " --token <HUB_TOKEN>", "```",
    "它会写入 ~/.config/agent-hub/env，并把 agent-hub 注册为 Claude Code、Codex、Cursor、VS Code（Copilot）、Copilot CLI、Kiro 的 MCP 服务器，给 Claude Code 和 Codex 打开 OTel 遥测（成本自动回传）。加 --dry-run 先看会改什么。", "",
    "## 2. 装入项目（每个仓库一次）", "```", "bash agent-kit-" + fileSafe(p.name) + "/install.sh <项目根目录>", "```",
    "安装脚本会复制文件（已存在且不同的 AGENTS.md、CLAUDE.md、Agent 配置另存为 *.agent-kit.new）、启用 git 钩子、检查 hub 连接、跑一次统一验证。确认后按提示提交。", "",
    "## 3. 每个任务", "```",
    "bash scripts/agent/task.sh new \"订单导出改为异步\" --allow 'src/order/**'   # 或在工作台建任务",
    "bash scripts/agent/task.sh start <任务编号> <简述>   # 分支 + worktree + 任务单，hub 标记执行中",
    "bash scripts/agent/task.sh run <任务编号> claude      # 或 codex / gemini / cursor / kiro / code",
    "#   Agent 会话开始时钩子注入任务单；结束时统一验证、回执自动回传，任务进入“待评审”或“需介入”",
    "bash scripts/agent/task.sh check <任务编号>          # 统一验证 + 越界检查，结果回传 hub",
    "#   在工作台评审：通过并合并 / 退回修改（选原因）",
    "bash scripts/agent/task.sh merge <任务编号>          # 合并，hub 标记已合并",
    "bash scripts/agent/task.sh clean <任务编号>", "```", "",
    "## 各 Agent 的接入方式", "| Agent | 规则 | 任务单注入 | 受保护路径拦截 | 结束前验证 | 回执回传 | 成本 |", "|---|---|---|---|---|---|---|",
    "| Claude Code | CLAUDE.md → @AGENTS.md | SessionStart 钩子 | PreToolUse 钩子 | Stop 钩子 | Stop 钩子 + MCP | OTel |",
    "| Codex | AGENTS.md | SessionStart 钩子 | PreToolUse 钩子 | Stop 钩子 | Stop 钩子 + MCP | OTel（token） |",
    "| Cursor | AGENTS.md | sessionStart 钩子 | preToolUse 钩子 | stop 钩子（followup） | afterAgentResponse 钩子 + MCP | — |",
    "| Copilot CLI / 云端 Agent | AGENTS.md | sessionStart 钩子 | preToolUse 钩子 | agentStop 钩子 | 会话记录尾部 + MCP | — |",
    "| Copilot（VS Code） | AGENTS.md | — | — | — | MCP | — |",
    "| Kiro | AGENTS.md + steering | SessionStart / AgentSpawn 钩子 | PreToolUse 钩子 | AgentStop 钩子 | MCP（主）+ AgentStop 钩子 | — |",
    "| 任何 Agent | AGENTS.md | specs/<编号>.md | git pre-commit | task.sh check / 合并前钩子 | 工作台“录入”粘贴 | 回执里填 |", "",
    "钩子只是加速器，兜底的是 git 钩子（禁止提交密钥、Agent 分支禁止提交受保护路径、自动补 Task 尾注、合并前再验证）和 task.sh check，对任何 Agent 都生效。", "",
    "## 文件", "- AGENTS.md：项目规则（工作台生成）；CLAUDE.md、.kiro/steering/agent-hub.md：各家补充",
    "- .claude/settings.json、.codex/hooks.json、.cursor/hooks.json、.github/hooks/agent-hub.json、.kiro/hooks/agent-hub.json：各 Agent 的钩子",
    "- scripts/agent/hub.sh：上报与 API 客户端（连不上 hub 时静默跳过）", "- scripts/agent/guard.sh、stop-verify.sh：受保护路径拦截、结束前验证（各 Agent 共用）",
    "- scripts/agent/verify.sh：统一验证入口；scripts/agent/task.sh：任务分支与 worktree", "- .githooks/：pre-commit、commit-msg、pre-merge-commit、post-commit", "",
    "## 排查", "- `bash scripts/agent/hub.sh ping` 检查连接；`AGENT_HUB_DISABLE=1` 临时关闭上报；`AGENT_SKIP_VERIFY=1` 临时跳过结束前验证",
    "- 在工作台“接入”页能看到每个 Agent 最近一次的钩子 / MCP / OTel 上报时间",
    "- Windows 请在 Git Bash 或 WSL 里使用。", ""].join("\n");
}

export function projectFiles(p, hubUrl) {
  const pr = lines(p.protect).map(shq).join("\n");
  return [
    ["AGENTS.md", agentsMd(p), false],
    ["CLAUDE.md", "@AGENTS.md\n\n<!-- Claude Code / Cowork 专用补充写在这里；通用规则请写进 AGENTS.md -->\n", false],
    [".claude/settings.json", claudeSettings(), false],
    [".codex/hooks.json", codexHooks(), false],
    [".cursor/hooks.json", cursorHooks(), false],
    [".github/hooks/agent-hub.json", copilotHooks(), false],
    [".kiro/hooks/agent-hub.json", kiroHooks(), false],
    [".kiro/steering/agent-hub.md", KIRO_STEERING, false],
    [".gemini/settings.json", J({ context: { fileName: ["AGENTS.md", "GEMINI.md"] } }), false],
    ["scripts/agent/verify.sh", tpl("scripts/verify.sh").replace("__PROJECT__", () => p.name).replace("__VERIFY_STEPS__", () => lines(p.verify).map(shq).join("\n")), true],
    ["scripts/agent/task.sh", tpl("scripts/task.sh"), true],
    ["scripts/agent/hub.sh", tpl("scripts/hub.sh"), true],
    ["scripts/agent/guard.sh", tpl("scripts/guard.sh").replace("__PROTECT__", () => pr), true],
    ["scripts/agent/stop-verify.sh", tpl("scripts/stop-verify.sh"), true],
    [".githooks/pre-commit", tpl("githooks/pre-commit").replace("__PROTECT__", () => pr), true],
    [".githooks/commit-msg", tpl("githooks/commit-msg"), true],
    [".githooks/pre-merge-commit", tpl("githooks/pre-merge-commit"), true],
    [".githooks/post-commit", tpl("githooks/post-commit"), true],
    ["specs/README.md", "# specs\n\n每个任务一份任务单：`<任务编号>.md`。`task.sh start` 会从 agent-hub 自动写入；也可以从工作台“复制任务单”粘贴。task.sh check 会读取其中“允许修改”一行做越界检查。\n", false],
    ["install.sh", tpl("install.sh"), true],
    ["AGENT-KIT.md", kitReadme(p, hubUrl), false],
  ];
}

export async function kitZip(p, hubUrl) {
  const zip = new JSZip(); const dir = "agent-kit-" + fileSafe(p.name);
  const root = zip.folder(dir);
  projectFiles(p, hubUrl).forEach(([f, c, x]) => root.file(f, c, { unixPermissions: x ? "755" : "644" }));
  const buffer = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
  return { filename: dir + ".zip", buffer };
}

export function connectScript(hubUrl) {
  return tpl("connect.mjs").replace(/__HUB_URL__/g, () => hubUrl);
}
