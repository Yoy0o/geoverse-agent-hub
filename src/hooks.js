// /hooks/:agent —— 各 Agent 钩子的统一入口（由仓库里的 scripts/agent/hub.sh 转发，也可以直接配成 HTTP 钩子）
// /v1/logs、/v1/metrics —— OTLP/HTTP JSON 遥测入口
import express from "express";
import { ingest, sessionStartResponse, kindOf } from "./ingest.js";
import { readBody, handleLogs, handleMetrics } from "./otlp.js";

function b64(v) { try { return v ? Buffer.from(String(v), "base64").toString("utf8") : ""; } catch { return ""; } }
const safe = (v, n = 120) => String(v || "").replace(/[^\w.@:+\-\u4e00-\u9fff ]/g, "").slice(0, n);
// 执行位置：hub.sh 从 .agent/run、runner.json 和环境变量（云端会话、Codespaces、CI）推断后放在请求头里
export function execMeta(req) {
  const location = String(req.get("x-hub-location") || req.query.location || "").toLowerCase();
  return {
    run: safe(req.get("x-hub-run") || req.query.run, 64), runner: safe(req.get("x-hub-runner") || req.query.runner, 64),
    location: location === "cloud" || location === "local" ? location : "", host: safe(b64(req.get("x-hub-host")) || req.query.host),
  };
}
function meta(req) {
  return Object.assign({
    task: String(req.get("x-hub-task") || req.query.task || ""),
    branch: String(req.get("x-hub-branch") || req.query.branch || ""),
    repo: b64(req.get("x-hub-repo")) || String(req.query.repo || ""),
    cwd: String(req.query.cwd || ""),
  }, execMeta(req));
}
const agentKey = (s) => String(s || "unknown").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "unknown";

export function hookRoutes(app, auth) {
  const raw = express.text({ type: () => true, limit: "4mb" });

  app.post("/hooks/:agent/transcript", auth, raw, (req, res) => {
    const agent = agentKey(req.params.agent);
    const r = ingest({ agent, kind: "transcript", event: "transcript", text: typeof req.body === "string" ? req.body : "", query: meta(req) });
    res.json({ ok: true, receipt: !!(r && r.receipt) });
  });

  app.post("/hooks/:agent", auth, raw, (req, res) => {
    const agent = agentKey(req.params.agent);
    let payload = {};
    const body = typeof req.body === "string" ? req.body : "";
    if (body.trim()) { try { payload = JSON.parse(body); } catch { payload = { text: body }; } }
    const event = String(req.query.event || payload.hook_event_name || payload.hookEventName || "event");
    const r = ingest({ agent, event, payload, query: meta(req), channel: "hooks" });
    if (kindOf(event) === "session.start") {
      const out = sessionStartResponse(agent, r.context);
      return out.type === "text" ? res.type("text/plain; charset=utf-8").send(out.body) : res.json(out.body);
    }
    res.json({});
  });

  const otlpBody = express.raw({ type: () => true, limit: "16mb" });
  const otlp = (fn) => (req, res) => {
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("protobuf")) return res.status(415).json({ error: "只支持 OTLP/HTTP JSON：设置 OTEL_EXPORTER_OTLP_PROTOCOL=http/json（Codex：protocol = \"json\"）" });
    let body;
    try { body = readBody(req); } catch (e) { return res.status(400).json({ error: "bad body: " + e.message }); }
    try { fn(body); } catch (e) { console.error("[otlp]", e); }
    res.json({ partialSuccess: {} });
  };
  app.post("/v1/logs", auth, otlpBody, otlp(handleLogs));
  app.post("/v1/metrics", auth, otlpBody, otlp(handleMetrics));
  app.post("/v1/traces", auth, otlpBody, (req, res) => res.json({ partialSuccess: {} }));
}
