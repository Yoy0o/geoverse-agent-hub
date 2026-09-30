// Real workerd/SQLite integration. Uses fixture secrets and isolated local state only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import JSZip from "jszip";

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
  for (const p of ["/", "/shim.js", "/api/health", "/api/export", "/mcp"]) {
    check((await call(p)).status === 401, `production Access gate protects ${p}`);
  }
  check((await call("/", { headers: { "Cf-Access-Authenticated-User-Email": "hio250@163.com", Authorization: "Bearer " + token } })).status === 401, "identity header plus Hub token cannot bypass Access");
  await stop();
  await start(true);
  check((await call("/")).status === 200, "local private-development page loads");
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
  const client = new Client({ name: "cloudflare-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
  check((await client.listTools()).tools.length === 13, "MCP SDK initialization and tool listing work in workerd");
  check((await client.callTool({ name: "get_task", arguments: { id } })).content[0].text.includes(id), "MCP reads shared SQLite task state");
  await client.close();
  const zipResponse = await api("/api/projects/fixture/kit.zip");
  const zip = await JSZip.loadAsync(await zipResponse.arrayBuffer());
  const script = await zip.file("agent-kit-fixture/scripts/agent/hub.sh").async("string");
  check(script.includes("CF-Access-Client-Secret"), "downloaded Agent kit contains Access credential support");
  check((await (await call("/connect.mjs")).text()).includes("access-client-id"), "Worker serves bundled connection templates without local filesystem");
  const exported = await api("/api/export"), backup = await json(exported);
  check(/no-store/.test(exported.headers.get("cache-control")) && backup.tasks.some(t => t.id === id), "private backup is authenticated and cannot be cached");
  await json(await api("/api/import", "POST", backup));
  check((await json(await api(`/api/tasks/${id}`))).goal === "broadcast fixture", "transactional backup import preserves task fields");
  await runOAuth();
  const login = await call("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  check((await call("/api/tasks", { headers: { Cookie: cookie } })).status === 200, "random browser session authenticates in Worker");
  await stop();
  await start(true);
  check((await json(await api(`/api/tasks/${id}`))).goal === "broadcast fixture", "SQLite data survives runtime restart");
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
