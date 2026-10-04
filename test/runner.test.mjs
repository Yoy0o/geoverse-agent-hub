// 执行端的跨平台逻辑：用模拟的 Windows 目录结构验证 Git Bash 查找与 Agent 命令解析
import { test } from "node:test";
import assert from "node:assert/strict";
import { findBash, resolveCommand } from "../kit/runner.mjs";

const fsOf = (files) => { const m = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v])); return { exists: (p) => m.has(p.toLowerCase()), read: (p) => m.get(p.toLowerCase()) }; };
const NPM_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");

test("finds Git Bash next to git.exe and never returns the WSL launcher", () => {
  const f = fsOf({ "D:\\Program Files\\Git\\bin\\bash.exe": "" });
  const where = (b) => (b === "git" ? ["D:\\Program Files\\Git\\cmd\\git.exe"] : ["C:\\Windows\\System32\\bash.exe"]);
  assert.equal(findBash({ platform: "win32", env: {}, exists: f.exists, where }), "D:\\Program Files\\Git\\bin\\bash.exe");
  const none = fsOf({});
  assert.equal(findBash({ platform: "win32", env: {}, exists: none.exists, where: (b) => (b === "bash" ? ["C:\\Windows\\System32\\bash.exe"] : []) }), null);
  const std = fsOf({ "C:\\Program Files\\Git\\bin\\bash.exe": "" });
  assert.equal(findBash({ platform: "win32", env: { ProgramFiles: "C:\\Program Files" }, exists: std.exists, where: () => [] }), "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("explicit bash wins; other platforms use bash from PATH", () => {
  assert.equal(findBash({ platform: "win32", env: { AGENT_HUB_BASH: "E:\\Git\\bin\\bash.exe" }, where: () => [] }), "E:\\Git\\bin\\bash.exe");
  assert.equal(findBash({ platform: "win32", env: {}, configured: "F:\\bash.exe", where: () => [] }), "F:\\bash.exe");
  assert.equal(findBash({ platform: "linux", env: {} }), "bash");
});

test("resolves .exe through PATH × PATHEXT and runs npm .cmd shims with node, without cmd.exe", () => {
  const env = { PATH: "C:\\Users\\me\\.local\\bin;C:\\Users\\me\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const f = fsOf({ "C:\\Users\\me\\.local\\bin\\claude.exe": "", "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd": NPM_SHIM, "C:\\Users\\me\\AppData\\Roaming\\npm\\odd.bat": "@echo off\r\nfoo %*" });
  const prompt = '执行任务 T1：用 bash scripts/agent/hub.sh progress <0-100> "<当前步骤>" 汇报 & | %PATH%';
  const claude = resolveCommand(["claude", "-p", prompt], { platform: "win32", env, exists: f.exists, read: f.read, node: "node.exe" });
  assert.equal(claude.file.toLowerCase(), "c:\\users\\me\\.local\\bin\\claude.exe");
  assert.deepEqual(claude.args, ["-p", prompt]);
  const codex = resolveCommand(["codex", "exec", prompt], { platform: "win32", env, exists: f.exists, read: f.read, node: "node.exe" });
  assert.deepEqual(codex, { file: "node.exe", args: ["C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "exec", prompt] });
  assert.match(resolveCommand(["odd"], { platform: "win32", env, exists: f.exists, read: f.read }).error, /批处理文件/);
  assert.match(resolveCommand(["missing"], { platform: "win32", env, exists: f.exists, read: f.read }).error, /找不到命令/);
  assert.deepEqual(resolveCommand(["claude", "-p", prompt], { platform: "linux" }), { file: "claude", args: ["-p", prompt] });
});
