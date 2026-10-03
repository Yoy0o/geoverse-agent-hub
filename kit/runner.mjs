#!/usr/bin/env node
// agent-hub 执行端（runner）：让这台电脑（或云端 VM、CI 机器）领取工作台派发的任务，并持续上报执行情况。
//   node runner.mjs register --name 工作站 --project demo=~/code/demo [--project 名称=路径 …] [--agents claude-code,codex] [--exec] [--max 1] [--bash <Git Bash 路径>] [--profile cloud]
//   node runner.mjs start  [--profile cloud] [--interval 30]   常驻：心跳 → 领取 → 准备分支与工作区（--exec 登记的还会启动 Agent）
//   node runner.mjs once   [--profile cloud]                   只跑一轮并等待启动的 Agent 结束（cron / 测试用）
//   node runner.mjs status [--profile cloud]                   本机配置与 hub 上的状态
//   node runner.mjs unregister [--profile cloud]
// 连接：AGENT_HUB_URL / AGENT_HUB_TOKEN / CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET 环境变量，
//       或 connect.mjs 写入的 ~/.config/agent-hub/<profile>.env（不传 --profile 时为 env）。
// 本机配置（项目路径、Agent 启动命令）保存在 ~/.config/agent-hub/runner[-<profile>].json，不会上传；hub 只知道项目名和 Agent 名。
// 安全：只处理登记过路径的项目；只在任务自己的 worktree 里运行；默认只准备工作区，--exec 登记后才会无人值守地启动 Agent。
// Windows：用 Git Bash 运行仓库脚本（自动查找，绝不使用 System32 的 WSL 启动器）；npm 安装的 .cmd 命令改用 node 直接运行其脚本。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";

const VERSION = "0.3.0";
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "help";
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const opts = (k) => args.flatMap((a, i) => (a === "--" + k && args[i + 1] !== undefined ? [args[i + 1]] : []));
const flag = (k) => args.includes("--" + k);
const PROFILE = opt("profile", "");
const HOME = os.homedir();
const CONF_DIR = path.join(HOME, ".config/agent-hub");
const RUNNER_FILE = process.env.AGENT_HUB_RUNNER_FILE || path.join(CONF_DIR, PROFILE ? `runner-${PROFILE}.json` : "runner.json");
const log = (...a) => console.log(new Date().toLocaleTimeString("zh-CN", { hour12: false }), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = (bin) => { try { execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
const whereAll = (bin) => { try { return execFileSync("where", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch { return []; } };
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, HOME));

// 无人值守启动各 Agent 的命令；{prompt} {task} {worktree} 会被替换。可以在 runner.json 里改或加自己的 Agent
// Claude Code 的 print 模式没人能批准权限请求：除了自动接受编辑，再放行接入包脚本和常用的只读 / 提交类 git 命令，
// Agent 才能自己跑统一验证、汇报进度、提交。其余命令仍会被拒绝。
const CLAUDE_ALLOWED = ["Bash(bash scripts/agent/*)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add *)", "Bash(git commit *)"];
const DEFAULT_AGENTS = {
  "claude-code": { bin: "claude", cmd: ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits", "--allowedTools", ...CLAUDE_ALLOWED] },
  codex: { bin: "codex", cmd: ["codex", "exec", "--full-auto", "{prompt}"] },
  gemini: { bin: "gemini", cmd: ["gemini", "-p", "{prompt}"] },
};
const PROMPT = (id) => `执行任务 ${id}：先阅读 specs/${id}.md（任务单），按验收标准和允许修改的范围实现；过程中可以用 bash scripts/agent/hub.sh progress <0-100> "<当前步骤>" 汇报进度；结束前运行 bash scripts/agent/verify.sh，最后按 AGENTS.md 输出交付回执（agent-receipt 代码块）。`;

/* ---------------- 跨平台：bash 与 Agent 命令 ---------------- */
// 找运行仓库脚本用的 bash。Windows 上 PATH 里的 bash 往往是 System32 的 WSL 启动器，必须避开
export function findBash({ platform = process.platform, env = process.env, configured = "", exists = fs.existsSync, where = whereAll } = {}) {
  if (env.AGENT_HUB_BASH) return env.AGENT_HUB_BASH;
  if (configured) return configured;
  if (platform !== "win32") return "bash";
  const w = path.win32, roots = [];
  for (const g of where("git")) roots.push(w.dirname(w.dirname(g)));           // <Git>\cmd\git.exe → <Git>
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs")]) if (base) roots.push(w.join(base, "Git"));
  for (const r of roots) for (const rel of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) { const p = w.join(r, rel); if (exists(p)) return p; }
  for (const b of where("bash")) if (!/\\windows\\(system32|syswow64)\\|\\windowsapps\\/i.test(b)) return b;
  return null;
}
// 把 Agent 命令解析成可以直接 spawn 的文件（不经过 shell）。Windows 上按 PATH × PATHEXT 查找；
// npm 生成的 .cmd 包装改为用 node 运行它指向的脚本——cmd.exe 的转义规则无法安全传递任意提示词
export function resolveCommand(argv, { platform = process.platform, env = process.env, exists = fs.existsSync, read = (f) => fs.readFileSync(f, "utf8"), node = process.execPath } = {}) {
  const [cmd, ...rest] = argv;
  if (platform !== "win32") return { file: cmd, args: rest };
  const w = path.win32;
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = /[\\/]/.test(cmd) ? [""] : String(env.PATH || env.Path || "").split(";").filter(Boolean);
  let found = null;
  search: for (const d of dirs) for (const e of /\.[a-z0-9]+$/i.test(cmd) ? [""] : exts) { const p = d ? w.join(d, cmd + e) : cmd + e; if (exists(p)) { found = p; break search; } }
  if (!found) return { error: `找不到命令「${cmd}」：确认已安装且在 PATH 中，或在 runner.json 的 agents 里写完整路径` };
  if (/\.(cmd|bat)$/i.test(found)) {
    const m = String(read(found) || "").match(/"%~?dp0%?\\([^"]+?\.[cm]?js)"/i);
    if (m) return { file: node, args: [w.join(w.dirname(found), m[1]), ...rest] };
    return { error: `${found} 是批处理文件，无法安全传递参数；请在 runner.json 的 agents 里改成 .exe 或 ["node", "<脚本路径>", …]` };
  }
  return { file: found, args: rest };
}

/* ---------------- 连接 ---------------- */
function readEnvFile(file) {
  const out = {};
  try { for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) out[m[1]] = m[2].replace(/^"|"$/g, ""); } } catch { /* 没有文件 */ }
  return out;
}
function connection() {
  const e = process.env;
  const file = e.AGENT_HUB_CONFIG || path.join(CONF_DIR, PROFILE ? PROFILE + ".env" : "env");
  const f = e.AGENT_HUB_URL ? {} : readEnvFile(file);
  const c = { url: String(e.AGENT_HUB_URL || f.AGENT_HUB_URL || "__HUB_URL__").replace(/\/+$/, ""), token: e.AGENT_HUB_TOKEN || f.AGENT_HUB_TOKEN || "", cfId: e.CF_ACCESS_CLIENT_ID || f.CF_ACCESS_CLIENT_ID || "", cfSecret: e.CF_ACCESS_CLIENT_SECRET || f.CF_ACCESS_CLIENT_SECRET || "", file };
  if (!c.url || c.url.includes("__HUB" + "_URL__") || !c.token) { console.error(`没有 agent-hub 连接配置：先运行 connect.mjs${PROFILE ? " --profile " + PROFILE : ""}，或设置 AGENT_HUB_URL / AGENT_HUB_TOKEN（查找的文件：${file}）`); process.exit(2); }
  return c;
}
let CONN = null;
async function api(method, p, body) {
  CONN = CONN || connection();
  const headers = { Authorization: "Bearer " + CONN.token, "Content-Type": "application/json" };
  if (CONN.cfId && CONN.cfSecret) Object.assign(headers, { "CF-Access-Client-Id": CONN.cfId, "CF-Access-Client-Secret": CONN.cfSecret });
  const r = await fetch(CONN.url + p, { method, headers, redirect: "manual", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (r.status >= 300 && r.status < 400) throw Object.assign(new Error("入口要求 Cloudflare Access 认证：提供本机服务凭证（CF_ACCESS_CLIENT_ID / SECRET）"), { status: r.status });
  const data = String(r.headers.get("content-type") || "").includes("json") ? await r.json().catch(() => ({})) : {};
  if (!r.ok) throw Object.assign(new Error((data && data.error) || "HTTP " + r.status), { status: r.status });
  return data;
}

/* ---------------- 本机配置 ---------------- */
function loadConf() { try { return JSON.parse(fs.readFileSync(RUNNER_FILE, "utf8")); } catch { return null; } }
function saveConf(c) { fs.mkdirSync(path.dirname(RUNNER_FILE), { recursive: true }); fs.writeFileSync(RUNNER_FILE, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 }); }
function detectKind() {
  const e = process.env;
  if (e.AGENT_HUB_LOCATION === "local" || e.AGENT_HUB_LOCATION === "cloud") return e.AGENT_HUB_LOCATION;
  if (e.GITHUB_ACTIONS || e.GITLAB_CI || e.CI) return "ci";
  if (e.CLAUDE_CODE_REMOTE || e.CODESPACES || e.GITPOD_WORKSPACE_ID || e.CLOUD_SHELL) return "cloud";
  return "local";
}
const hostName = () => process.env.AGENT_HUB_HOST || os.hostname();
function registration(c) {
  return { id: c.id, name: c.name, kind: c.kind, host: hostName(), platform: `${process.platform}-${process.arch}`, agents: Object.keys(c.agents || {}), projects: Object.keys(c.projects || {}), mode: c.mode, maxRuns: c.max, version: VERSION };
}

async function register() {
  const prev = loadConf() || {};
  const projects = Object.assign({}, prev.projects || {});
  for (const p of opts("project")) {
    const i = p.indexOf("="); if (i <= 0) { console.error("--project 格式：项目名=本地路径"); process.exit(1); }
    const dir = expand(p.slice(i + 1));
    if (!fs.existsSync(dir)) { console.error("路径不存在：" + dir); process.exit(1); }
    if (!fs.existsSync(path.join(dir, "scripts/agent/task.sh"))) console.warn(`提示：${dir} 还没装接入包（scripts/agent/task.sh），领取到该项目的任务会失败`);
    projects[p.slice(0, i).trim()] = dir;
  }
  for (const p of opts("remove-project")) delete projects[p];
  const agents = Object.assign({}, prev.agents || {});
  const want = opt("agents", "");
  if (want) for (const k of want.split(",").map((s) => s.trim()).filter(Boolean)) { if (DEFAULT_AGENTS[k]) agents[k] = DEFAULT_AGENTS[k].cmd; else if (!agents[k]) console.warn("未知 Agent：" + k + "（可以用 --agent-cmd " + k + "='[\"命令\",\"{prompt}\"]' 自定义）"); }
  else if (!Object.keys(agents).length && !opts("agent-cmd").length) for (const [k, a] of Object.entries(DEFAULT_AGENTS)) if (which(a.bin)) agents[k] = a.cmd;
  for (const p of opts("agent-cmd")) {
    const i = p.indexOf("="); let v = null;
    try { v = JSON.parse(p.slice(i + 1)); } catch { /* 下面报错 */ }
    if (i <= 0 || !Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string")) { console.error("--agent-cmd 格式：名称='[\"命令\",\"参数\",\"{prompt}\"]'"); process.exit(1); }
    agents[p.slice(0, i).trim()] = v;
  }
  const bash = opt("bash", prev.bash || "");
  if (bash && !fs.existsSync(bash)) { console.error("找不到 bash：" + bash); process.exit(1); }
  if (process.platform === "win32" && !findBash({ configured: bash })) console.warn("提示：没有找到 Git Bash。安装 Git for Windows，或用 --bash \"D:/Program Files/Git/bin/bash.exe\" 指定");
  const c = {
    id: prev.id, name: opt("name", prev.name || hostName()), kind: opt("kind", prev.kind || detectKind()), bash: bash || undefined,
    mode: flag("exec") ? "exec" : flag("prepare-only") ? "prepare" : prev.mode || "prepare", max: Math.min(8, Math.max(1, Number(opt("max", prev.max || 1)) || 1)), projects, agents,
  };
  const r = await api("POST", "/api/runners", registration(c));
  c.id = r.runner.id; saveConf(c);
  console.log(`已登记执行端「${c.name}」（${c.id}）→ ${CONN.url}`);
  console.log(`  类型 ${c.kind} · ${c.mode === "exec" ? "自动执行（领取后无人值守启动 Agent）" : "只准备工作区（领取后建分支和 worktree，由你启动 Agent）"} · 并发 ${c.max}`);
  console.log("  项目：" + (Object.entries(projects).map(([k, v]) => k + " → " + v).join("；") || "（无，用 --project 名称=路径 添加）"));
  console.log("  Agent：" + (Object.keys(agents).join("、") || "（无）"));
  if (process.platform === "win32") console.log("  bash：" + (findBash({ configured: c.bash }) || "未找到"));
  console.log(`  配置文件：${RUNNER_FILE}（可以直接编辑 Agent 启动命令）`);
  console.log(`\n下一步：node ${path.basename(process.argv[1])} start${PROFILE ? " --profile " + PROFILE : ""}   # 常驻运行，建议放进开机自启或 tmux`);
}

/* ---------------- 执行 ---------------- */
const active = new Map(); // runId -> { run, task, child, cancelled }
let CONF = null;
function childEnv(run) {
  CONN = CONN || connection();
  return Object.assign({}, process.env, {
    AGENT_HUB_URL: CONN.url, AGENT_HUB_TOKEN: CONN.token, CF_ACCESS_CLIENT_ID: CONN.cfId, CF_ACCESS_CLIENT_SECRET: CONN.cfSecret,
    AGENT_HUB_RUN: run.id, AGENT_HUB_RUNNER: CONF.id, AGENT_HUB_LOCATION: CONF.kind === "local" ? "local" : "cloud", AGENT_HUB_HOST: hostName(),
    AGENT_HUB_AGENT: run.agent || "task-sh",
  });
}
const update = (id, body) => api("POST", `/api/runs/${encodeURIComponent(id)}/update?agent=runner`, body).catch((e) => log("! 回报失败：" + e.message));
const tail = (s, n = 600) => String(s || "").trim().slice(-n);
function slug(t) { const s = String(t.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30); return s || "task"; }

async function handle({ run, task }) {
  const repo = CONF.projects[task.project];
  const fail = async (note) => { active.delete(run.id); log(`✗ ${task.id}：${note}`); await update(run.id, { status: "failed", note }); };
  // 本机防护：任务编号只能是安全的文件名；本机没用 --exec 登记时，无论 hub 怎么派发都只准备工作区
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(task.id || ""))) return fail("任务编号不合法，拒绝处理");
  if (run.mode === "exec" && CONF.mode !== "exec") run = Object.assign({}, run, { mode: "prepare" });
  if (!repo) return fail(`本机没有登记项目「${task.project || "未指定"}」的路径：node runner.mjs register --project ${task.project || "<项目名>"}=<仓库路径>`);
  if (!fs.existsSync(path.join(repo, "scripts/agent/task.sh"))) return fail(`项目未安装接入包：${repo} 缺少 scripts/agent/task.sh`);
  log(`→ 领取 ${task.id}「${task.title}」（${run.mode === "exec" ? "自动执行" : "准备工作区"}${run.agent ? " · " + run.agent : ""}）`);
  const bash = findBash({ configured: CONF.bash });
  if (!bash) return fail("找不到 Git Bash：安装 Git for Windows，或 node runner.mjs register --bash \"<Git>/bin/bash.exe\"");
  await update(run.id, { step: "准备分支与工作区", progress: 8 });
  const env = childEnv(run);
  const st = spawnSync(bash, ["scripts/agent/task.sh", "start", task.id, slug(task), "--reuse", "--agent", run.agent || ""], { cwd: repo, env, encoding: "utf8", timeout: 180000 });
  if (st.error) return fail("无法运行 bash（" + bash + "）：" + st.error.message);
  if (st.status !== 0) return fail("task.sh start 失败：" + tail(st.stderr || st.stdout, 300));
  const wt = String(spawnSync(bash, ["scripts/agent/task.sh", "path", task.id], { cwd: repo, env, encoding: "utf8" }).stdout || "").trim();
  if (!wt || !fs.existsSync(wt)) return fail("找不到任务的 worktree");
  if (run.mode !== "exec") {
    active.delete(run.id);
    await update(run.id, { status: "ready", worktree: wt, step: "工作区已就绪，等待启动 Agent" });
    log(`✓ ${task.id} 工作区已就绪：${wt}\n    启动 Agent：cd "${wt}" && claude   （或 bash scripts/agent/task.sh run ${task.id} codex）`);
    return;
  }
  const tmpl = CONF.agents[run.agent];
  if (!Array.isArray(tmpl) || !tmpl.length) return fail(`本机没有配置 Agent「${run.agent || "未指定"}」的启动命令（runner.json 的 agents）`);
  const argv = tmpl.map((a) => a.replace(/\{prompt\}/g, PROMPT(task.id)).replace(/\{task\}/g, task.id).replace(/\{worktree\}/g, wt));
  const cmdline = resolveCommand(argv);
  if (cmdline.error) return fail(cmdline.error);
  fs.mkdirSync(path.join(wt, ".agent"), { recursive: true });
  const logFile = path.join(wt, ".agent", `run-${run.id}.log`);
  const out = fs.openSync(logFile, "a");
  let child;
  try { child = spawn(cmdline.file, cmdline.args, { cwd: wt, env, stdio: ["ignore", out, out], detached: process.platform !== "win32", windowsHide: true }); }
  catch (e) { fs.closeSync(out); return fail("启动 Agent 失败：" + e.message); }
  fs.closeSync(out);
  const a = active.get(run.id); if (a) a.child = child;
  let finished = false;
  const done = new Promise((resolve) => {
    // 命令不存在等启动错误只触发 error，不一定有 exit
    child.on("error", async (e) => {
      if (finished) return; finished = true; active.delete(run.id);
      log(`✗ ${task.id} 启动失败：${e.message}`);
      await update(run.id, { status: "failed", note: "启动 Agent 失败：" + e.message + `（命令 ${argv[0]}）` });
      resolve();
    });
    child.on("exit", async (code, signal) => {
      if (finished) return; finished = true;
      const cur = active.get(run.id); active.delete(run.id);
      if (cur && cur.cancelled) { log(`■ ${task.id} 已停止`); await update(run.id, { status: "cancelled", exitCode: code ?? -1 }); return resolve(); }
      // 回执兜底：钩子没有送达时，从 Agent 的输出里提取（hub 按指纹去重）
      let text = "";
      try { const size = fs.statSync(logFile).size; const fd = fs.openSync(logFile, "r"); const n = Math.min(size, 262144); const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd); text = buf.toString("utf8"); } catch { /* 没有输出 */ }
      if (/agent-receipt/i.test(text)) await api("POST", `/api/tasks/${encodeURIComponent(task.id)}/receipt?agent=${encodeURIComponent(run.agent || "runner")}`, { text }).catch((e) => log("! 回执上报失败：" + e.message));
      const exitCode = code ?? (signal ? 128 : 1);
      log(`${exitCode === 0 ? "✓" : "✗"} ${task.id} Agent 已退出（${signal || "退出码 " + exitCode}）· 输出：${logFile}`);
      await update(run.id, { status: "exited", exitCode });
      resolve();
    });
  });
  if (a) a.done = done;
  log(`▶ ${task.id} 已启动 ${run.agent}（pid ${child.pid}）· 输出：${logFile}`);
  await update(run.id, { status: "running", worktree: wt, step: `${run.agent} 运行中（pid ${child.pid}）`, agent: run.agent });
}
function stop(runId, why) {
  const a = active.get(runId);
  if (!a) return;
  if (!a.child) { active.delete(runId); return; }
  if (a.cancelled) return;
  a.cancelled = true;
  log(`■ 停止 ${a.task.id}（${why}）`);
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(a.child.pid), "/T", "/F"], { stdio: "ignore" });
    else { process.kill(-a.child.pid, "SIGTERM"); setTimeout(() => { try { process.kill(-a.child.pid, "SIGKILL"); } catch { /* 已退出 */ } }, 10000).unref(); }
  } catch { /* 已退出 */ }
}

async function cycle() {
  const hb = await api("POST", `/api/runners/${encodeURIComponent(CONF.id)}/heartbeat`, { runs: [...active.keys()].map((id) => ({ id })), version: VERSION });
  for (const id of hb.cancel || []) stop(id, "工作台取消或任务已结束");
  let free = CONF.max - [...active.values()].filter((a) => a.child && !a.cancelled).length;
  for (let n = hb.queued || 0; n > 0 && free > 0; n--) {
    const c = await api("POST", `/api/runners/${encodeURIComponent(CONF.id)}/claim`, {});
    if (!c.run) break;
    active.set(c.run.id, { run: c.run, task: c.task });
    await handle(c).catch(async (e) => { active.delete(c.run.id); log("✗ 处理失败：" + e.message); await update(c.run.id, { status: "failed", note: "执行端出错：" + e.message }); });
    if (c.run.mode === "exec") free--;
  }
}
function requireConf() {
  const c = loadConf();
  if (!c || !c.id) { console.error(`本机还没登记执行端：先运行 node runner.mjs register --name <名称> --project <项目名>=<路径>${PROFILE ? " --profile " + PROFILE : ""}`); process.exit(2); }
  c.projects = c.projects || {}; c.agents = c.agents || {}; c.max = c.max || 1; c.mode = c.mode || "prepare"; c.kind = c.kind || detectKind();
  return c;
}

async function start(once) {
  CONF = requireConf();
  await api("POST", "/api/runners", registration(CONF));
  if (!once) log(`执行端「${CONF.name}」已上线 → ${CONN.url}（${CONF.mode === "exec" ? "自动执行" : "只准备工作区"}，每 ${Number(opt("interval", 30))} 秒检查一次，Ctrl+C 退出）`);
  if (once) {
    await cycle();
    await Promise.all([...active.values()].map((a) => a.done).filter(Boolean));
    await api("POST", `/api/runners/${encodeURIComponent(CONF.id)}/heartbeat`, { runs: [], version: VERSION }).catch(() => {});
    return;
  }
  let quit = false, lastErr = "";
  const shutdown = async () => {
    if (quit) process.exit(1);
    quit = true; log("正在退出：停止本执行端启动的 Agent…");
    for (const id of active.keys()) stop(id, "执行端退出");
    await Promise.race([Promise.all([...active.values()].map((a) => a.done).filter(Boolean)), sleep(15000)]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  // 默认 30 秒：Hub 判定离线的阈值是 90 秒（容忍两次心跳丢失），同时控制云端免费额度里的请求与写入量
  const every = Math.max(3, Number(opt("interval", 30)) || 30) * 1000;
  while (!quit) {
    try { await cycle(); if (lastErr) { log("已恢复连接"); lastErr = ""; } }
    catch (e) {
      if (e.status === 404) { console.error("执行端已在工作台移除；重新运行 register 后再启动"); process.exit(1); }
      if (e.message !== lastErr) log("! 连接 hub 失败：" + e.message + "（稍后重试）");
      lastErr = e.message;
    }
    await sleep(every);
  }
}

async function status() {
  const c = loadConf();
  if (!c) { console.log("本机还没登记执行端（" + RUNNER_FILE + "）"); return; }
  console.log(`执行端「${c.name}」（${c.id}）· ${c.kind} · ${c.mode === "exec" ? "自动执行" : "只准备工作区"} · 并发 ${c.max}`);
  console.log("配置文件：" + RUNNER_FILE);
  for (const [k, v] of Object.entries(c.projects || {})) console.log(`  项目 ${k} → ${v}${fs.existsSync(path.join(v, "scripts/agent/task.sh")) ? "" : "（缺少接入包）"}`);
  for (const [k, v] of Object.entries(c.agents || {})) { const r = resolveCommand(v); console.log(`  Agent ${k}：${v.join(" ")}${r.error ? "（" + r.error + "）" : ""}`); }
  console.log("  bash：" + (findBash({ configured: c.bash }) || "未找到（Windows 需要 Git Bash）"));
  const list = await api("GET", "/api/runners");
  const me = list.find((r) => r.id === c.id);
  console.log(me ? `hub：${me.online ? "在线" : "离线"} · 最近心跳 ${me.lastSeen || "—"} · 进行中 ${me.active}` : "hub 上没有这个执行端（已被移除？重新 register）");
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) try {
  if (cmd === "register") await register();
  else if (cmd === "start") await start(false);
  else if (cmd === "once") await start(true);
  else if (cmd === "status") await status();
  else if (cmd === "unregister") {
    const c = loadConf(); if (!c || !c.id) { console.log("本机没有登记执行端"); process.exit(0); }
    await api("DELETE", `/api/runners/${encodeURIComponent(c.id)}`); fs.rmSync(RUNNER_FILE, { force: true }); console.log("已移除执行端「" + c.name + "」");
  } else console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
} catch (e) { console.error("✗ " + e.message); process.exit(1); }
