// Real workerd/SQLite integration. Uses fixture secrets and isolated local state only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { version } from "../src/version.js";

const port = Number(process.env.TEST_CF_PORT || 8795), base = `http://127.0.0.1:${port}`;
const token = "cloudflare-fixture-token-not-a-real-secret";
const persist = path.resolve(".wrangler", "integration-" + Date.now());
const environment = { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" };
let processHandle, log = "", checks = 0, reader, streamController;
const check = (condition, message) => { assert.ok(condition, message); checks++; console.log("✓ " + message); };
const call = (p, options = {}) => fetch(base + p, { ...options, signal: options.signal || AbortSignal.timeout(15000) });
const api = (p, method = "GET", body) => call(p, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async response => { assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json(); };
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const child = processHandle, exited = once(child, "exit");
  if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
  await exited; processHandle = null;
}
async function start(local) {
  log = "";
  const vars = {
    HUB_TOKEN: token, LOCAL_DEV: local ? "1" : "0", PUBLIC_URL: local ? base : "https://hub.example.com",
    OAUTH_ENABLED: local ? "1" : "0", ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "fixture-app",
  };
  const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--port", String(port), "--persist-to", persist, "--show-interactive-dev-session=false"];
  for (const [name, value] of Object.entries(vars)) args.push("--var", `${name}:${value}`);
  processHandle = spawn(process.execPath, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  processHandle.stdout.on("data", d => log += d); processHandle.stderr.on("data", d => log += d);
  for (let i = 0; i < 180; i++) {
    if (processHandle.exitCode !== null) throw new Error("Wrangler exited: " + log);
    try { const res = await call("/api/health", { signal: AbortSignal.timeout(2000) }); if (local ? res.status === 200 : res.status === 401) return; } catch { /* startup */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("Wrangler did not become ready: " + log);
}
async function runOAuth() {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "test/oauth.mjs"], { env: { ...environment, TEST_HUB_URL: base, TEST_HUB_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", d => output += d); child.stderr.on("data", d => output += d);
  const [code] = await once(child, "exit"); assert.equal(code, 0, output); console.log(output.trim());
  checks += 14;
}

try {
  await fs.mkdir(persist, { recursive: true });
  await start(false);
  for (const p of ["/", "/shim.js", "/focus.js", "/focus.css", "/task-edits.js", "/api/health", "/api/focus", "/api/export", "/mcp"]) {
    check((await call(p)).status === 401, `production Access gate protects ${p}`);
  }
  check((await call("/", { headers: { "Cf-Access-Authenticated-User-Email": "hio250@163.com", Authorization: "Bearer " + token } })).status === 401, "identity header plus Hub token cannot bypass Access");
  await stop();
  await start(true);
  check((await call("/")).status === 200, "local private-development page loads");
  const releaseHealth = await json(await api("/api/health"));
  const releaseCaps = await json(await api("/api/capabilities"));
  check(releaseHealth.version === version && releaseCaps.version === version, "Node and Worker use the package release version");
  check(/^[a-f0-9]{40}$/.test(releaseHealth.build.commit) && releaseHealth.build.commit === releaseCaps.build.commit, "health and capabilities identify the same build commit");
  for (const file of ["index.html", "shim.js", "focus.js", "focus.css", "task-edits.js"]) {
    const expected = createHash("sha256").update(await fs.readFile("public/" + file)).digest("hex");
    const deployed = await (await call(file === "index.html" ? "/" : "/" + file)).arrayBuffer();
    check(releaseHealth.build.assets[file] === expected && createHash("sha256").update(Buffer.from(deployed)).digest("hex") === expected, "build manifest matches served " + file);
  }
  check((await call("/api/tasks")).status === 401, "Hub still requires authentication in local mode");
  check((await json(await api("/api/capabilities"))).oauth, "Worker OAuth routes initialize with Durable Object storage");
  const config = await json(await api("/api/docs/config/main"));
  config.data.projects = [{ name: "fixture", path: "/fixture", verify: ["node --version"], protect: ["*.lock"] }];
  await json(await api("/api/docs/config/main", "PUT", config.data));
  const created = await json(await api("/api/tasks", "POST", { title: "Workers persistence fixture", project: "fixture", allow: "src/**", acceptance: ["fixture"] }));
  const id = created.id;
  check(!!id, "task creation persists into Durable Objects SQLite");
  await json(await api(`/api/tasks/${id}/start`, "POST", { branch: `agent/${id}-fixture`, worktree: "/fixture/worktree" }));
  check((await json(await api(`/api/tasks/${id}`))).status === "执行中", "task state transition works");
  const stageBefore = await json(await api(`/api/tasks/${id}/focus`));
  const stageReport = '```agent-work-brief\n' + JSON.stringify({ task: id, expectedFingerprint: stageBefore.fingerprint, content: { summary: "Stage transport verified", nextAction: "Continue integration" } }) + '\n```';
  await json(await api(`/hooks/codex?event=Stop&task=${id}`, "POST", { last_assistant_message: stageReport }));
  const stageAfter = await json(await api(`/api/tasks/${id}/focus`));
  check(stageAfter.content.summary === "Stage transport verified" && stageAfter.status === "执行中", "workerd hook updates a milestone without completing the task");
  check((await json(await api(`/api/tasks/${id}/focus/report`, "POST", { text: stageReport }))).status === "unchanged", "workerd runner replay does not rewrite a milestone");
  check((await api(`/api/tasks/${id}/focus/report`, "POST", { text: stageReport.replace("Stage transport verified", "Stale milestone") })).status === 409, "workerd rejects stale milestone context");

  streamController = new AbortController();
  const stream = await call("/api/stream", { headers: { Authorization: "Bearer " + token }, signal: streamController.signal });
  check(stream.ok && /text\/event-stream/.test(stream.headers.get("content-type")), "SSE opens inside owning Durable Object");
  reader = stream.body.getReader();
  await reader.read();
  await json(await api(`/api/docs/tasks/${id}`, "PATCH", { goal: "broadcast fixture" }));
  let message = "";
  const event = async () => { while (!message.includes("broadcast fixture")) { const chunk = await reader.read(); if (chunk.done) throw new Error("SSE closed early"); message += new TextDecoder().decode(chunk.value); } };
  const timeout = setTimeout(() => streamController.abort(), 5000);
  try { await event(); check(message.includes('event: doc'), "document changes reach the active SSE subscriber"); } finally { clearTimeout(timeout); await reader.cancel(); reader = null; streamController.abort(); }

  const hook = await json(await api(`/hooks/codex?task=${id}&event=SessionStart`, "POST", { session_id: "fixture-session", cwd: "/fixture", source: "startup" }));
  check(hook.hookSpecificOutput.additionalContext.includes(id), "Agent hooks receive the task brief");
  const attributes = Object.entries({ "service.name": "claude-code", "session.id": "fixture-session", "agent_hub.task": id, "event.name": "claude_code.api_request", input_tokens: "20", output_tokens: "10", cost_usd: "0.01" }).map(([key, value]) => ({ key, value: { stringValue: value } }));
  await json(await api("/v1/logs", "POST", { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ attributes }] }] }] }));
  check((await json(await api(`/api/tasks/${id}/activity`))).sessions.some(s => s.tokens_in === 20), "OTLP telemetry persists and updates session usage");
  const status = await json(await api("/api/agents/status"));
  check(status.agents.some(a => a.agent === "codex" && a.events24h > 0), "agent status uses the bounded time-index query in Durable Objects SQLite");
  const client = new Client({ name: "cloudflare-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
  const toolNames = (await client.listTools()).tools.map(t => t.name).sort();
  const expectedTools = ["today", "list_tasks", "get_task", "create_task", "update_task", "start_task", "report_progress", "dispatch_task", "list_runs", "cancel_run", "submit_receipt", "move_task", "list_rules", "add_rule", "get_project", "log_note", "task_usage", "get_focus", "get_work_context", "update_work_brief", "pause_task", "resume_task"].sort();
  check(toolNames.length === expectedTools.length && expectedTools.every((name, i) => toolNames[i] === name), "MCP SDK initializes with the complete tool inventory in workerd");
  check((await client.callTool({ name: "get_task", arguments: { id } })).content[0].text.includes(id), "MCP reads shared SQLite task state");
  const context = JSON.parse((await client.callTool({ name: "get_work_context", arguments: { id } })).content[0].text);
  const brief = await client.callTool({ name: "update_work_brief", arguments: { id, expectedFingerprint: context.expectedFingerprint, content: { summary: "Durable work context", decision: "Proceed with the query?", recommendation: "Ship query first" } } });
  check(!brief.isError, "MCP updates concise work context in Durable Objects");
  const focusPath = `/api/tasks/${id}/focus`;
  const work = await json(await api(focusPath));
  check(work.snapshot.summary === "Durable work context" && work.unread && work.needsDecision, "REST reads the same work snapshot as MCP");
  check((await api(focusPath + "/read", "POST", { expectedFingerprint: context.expectedFingerprint })).status === 409, "stale reading state is rejected in workerd");
  const read = await json(await api(focusPath + "/read", "POST", { expectedFingerprint: work.fingerprint }));
  check(!read.unread && read.needsDecision, "reading does not resolve a decision in Durable Objects");
  const accepted = await json(await api(focusPath + "/decision", "POST", { expectedFingerprint: work.fingerprint, action: "accept" }));
  check(!accepted.needsDecision && (await json(await api(`/api/tasks/${id}`))).status === "执行中", "accepting a recommendation never completes the task");
  const daily = JSON.parse((await client.callTool({ name: "get_focus", arguments: {} })).content[0].text);
  check(typeof daily.counts.attention === "number", "MCP daily focus executes in workerd");
  await client.callTool({ name: "report_progress", arguments: { task: id, progress: 40, step: "workerd fixture" } });
  check((await json(await api(`/api/tasks/${id}`))).exec.progress === 40, "MCP progress updates the execution summary in Durable Objects");
  await client.close();

  // 执行端：登记 → 派发 → 领取 → 回报（Durable Object 里的新表与迁移）
  const runner = (await json(await api("/api/runners", "POST", { name: "workerd-runner", kind: "cloud", projects: ["fixture"], agents: ["codex"], mode: "exec" }))).runner;
  const dispatched = await json(await api(`/api/tasks/${id}/dispatch`, "POST", { mode: "exec", agent: "codex", runner: runner.id, force: true }));
  check(dispatched.run.status === "queued" && dispatched.prompt.includes(id), "dispatch queues a run for a registered runner");
  const claimed = await json(await api(`/api/runners/${runner.id}/claim`, "POST", {}));
  check(claimed.run && claimed.run.id === dispatched.run.id && claimed.run.location === "cloud", "runner claims the queued run atomically");
  await json(await api(`/api/runs/${claimed.run.id}/update`, "POST", { status: "running", step: "codex 运行中" }));
  check((await json(await api("/api/exec"))).active.some(r => r.id === claimed.run.id && r.health === "running"), "execution overview reports live runs and runner health");
  const beforePause = await json(await api(`/api/tasks/${id}/lifecycle`));
  const paused = await json(await api(`/api/tasks/${id}/pause`, "POST", { expectedFingerprint: beforePause.expectedFingerprint, reason: "Workerd checkpoint", summary: "Durable work context", nextAction: "Run the next experiment" }));
  check(paused.status === "已暂停" && paused.execution.state === "stopping", "pause checkpoints persist and wait for runner acknowledgement in workerd");
  check((await api(`/api/tasks/${id}/resume`, "POST", { expectedFingerprint: paused.expectedFingerprint })).status === 409, "resume cannot bypass pending execution stop");
  await json(await api(`/api/runs/${claimed.run.id}/update`, "POST", { status: "cancelled", exitCode: 143 }));
  const resumed = await json(await api(`/api/tasks/${id}/resume`, "POST", { expectedFingerprint: paused.expectedFingerprint }));
  check(resumed.status === "待执行" && resumed.activeMs === paused.activeMs, "resume preserves active time and does not start a process in workerd");
  // 多端同步：对端接口在 workerd 中可用
  const info = await json(await api("/api/sync/info"));
  const changes = await json(await api(`/api/sync/changes?since=-1&peer=fixture-peer`));
  check(info.kind === "cloud" && changes.changes.some(c => c.coll === "tasks" && c.id === id), "sync change feed lists Durable Object documents");
  const applied = await json(await api("/api/sync/apply", "POST", { peer: "fixture-peer", docs: [{ coll: "rules", id: "R-sync", data: { text: "同步来的规则", status: "待写入" }, updatedAt: new Date().toISOString(), base: changes.seq }, { coll: "tasks", id, data: { title: "stale" }, base: 0 }] }));
  check(applied.applied === 1 && applied.rejected.includes(`tasks/${id}`), "sync apply accepts new documents and rejects stale overwrites");
  const zipResponse = await api("/api/projects/fixture/kit.zip");
  const zip = await JSZip.loadAsync(await zipResponse.arrayBuffer());
  const script = await zip.file("agent-kit-fixture/scripts/agent/hub.sh").async("string");
  check(script.includes("CF-Access-Client-Secret"), "downloaded Agent kit contains Access credential support");
  check((await (await call("/connect.mjs")).text()).includes("access-client-id"), "Worker serves bundled connection templates without local filesystem");
  const exported = await api("/api/export"), backup = await json(exported);
  check(/no-store/.test(exported.headers.get("cache-control")) && backup.tasks.some(t => t.id === id), "private backup is authenticated and cannot be cached");
  await json(await api("/api/import", "POST", backup));
  check((await json(await api(`/api/tasks/${id}`))).goal === "broadcast fixture", "transactional backup import preserves task fields");
  check((await json(await api(focusPath))).content.summary === "Durable work context", "backup import preserves the work brief");
  await runOAuth();
  const login = await call("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  check((await call("/api/tasks", { headers: { Cookie: cookie } })).status === 200, "random browser session authenticates in Worker");
  await stop();
  await start(true);
  check((await json(await api(`/api/tasks/${id}`))).goal === "broadcast fixture", "SQLite data survives runtime restart");
  const persistedWork = await json(await api(focusPath));
  check(persistedWork.content.summary === "Durable work context" && persistedWork.readAt && persistedWork.resolution?.action === "accept", "work brief, reading state and decision survive runtime restart");
  const persistedLifecycle = await json(await api(`/api/tasks/${id}/lifecycle`));
  check(persistedLifecycle.checkpoint.reason === "Workerd checkpoint" && persistedLifecycle.checkpoint.resumedAt && persistedLifecycle.activeMs === paused.activeMs, "checkpoint and stopped workflow clock survive backup and runtime restart");
  check((await call("/api/tasks", { headers: { Cookie: cookie } })).status === 200, "stored browser session survives runtime restart");
  const logoutStream = await call("/api/stream", { headers: { Cookie: cookie } });
  const logoutReader = logoutStream.body.getReader();
  await logoutReader.read();
  await call("/api/logout", { method: "POST", headers: { Cookie: cookie, "X-Requested-With": "agent-hub" } });
  check((await logoutReader.read()).done, "logout closes the already-open cookie SSE subscription");
  check((await call("/api/tasks", { headers: { Cookie: cookie } })).status === 401, "logout revokes the session in persistent storage");
  console.log(`Cloudflare integration: ${checks} checks passed.`);
} catch (error) { console.error(log); throw error; }
finally {
  if (reader) await reader.cancel().catch(() => {});
  streamController?.abort();
  await stop();
}
