// OpenTelemetry 接收（OTLP/HTTP JSON）：Claude Code、Codex 的遥测 → 会话成本 / token / 改动行数 → 汇总到任务
import zlib from "node:zlib";
import { config } from "#hub/config";
import { touchSession, bumpSession, getSession, kv } from "#hub/db";
import { resolveTask, recomputeUsage, markChannel } from "./ingest.js";

function val(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return !!v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  return null;
}
function attrs(list) { const o = {}; (list || []).forEach((a) => { if (a && a.key) o[a.key] = val(a.value); }); return o; }
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function agentOf(a) {
  const s = String(a["agent_hub.agent"] || a["service.name"] || "").toLowerCase();
  if (s.includes("claude")) return "claude-code";
  if (s.includes("codex")) return "codex";
  if (s.includes("copilot")) return "copilot";
  if (s.includes("gemini")) return "gemini";
  return s || "otel";
}
function price(model, tin, tout) {
  const p = config.priceTable[model] || config.priceTable[String(model || "").replace(/-\d{8}$/, "")];
  return p ? (tin * (p.in || 0) + tout * (p.out || 0)) / 1e6 : 0;
}

export function readBody(req) {
  let buf = req.body;
  if (!Buffer.isBuffer(buf)) return typeof buf === "object" && buf ? buf : {};
  // express 已按 Content-Encoding 解压过；这里只处理仍是压缩数据的情况
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString("utf8") || "{}");
}

// 按会话累加，一次请求结束后统一写库
function acc(map, session, agent, a) {
  const k = session;
  const o = map.get(k) || { agent, cost: 0, tin: 0, tout: 0, model: "", task: a["agent_hub.task"] || "", lines: 0 };
  map.set(k, o); return o;
}
function flush(map, channel) {
  const tasks = new Set();
  for (const [session, o] of map) {
    if (!o.cost && o.model && (o.tin || o.tout)) o.cost = price(o.model, o.tin, o.tout);
    const before = getSession(session);
    const t = resolveTask({ hint: o.task, session });
    touchSession(session, { agent: o.agent, task: t ? t.id : null, model: o.model, channel });
    bumpSession(session, { cost_usd: o.cost, tokens_in: o.tin, tokens_out: o.tout });
    markChannel(o.agent, channel);
    const task = t ? t.id : before && before.task;
    if (task && (o.cost || o.tin || o.tout)) tasks.add(task);
  }
  tasks.forEach(recomputeUsage);
  return tasks.size;
}

export function handleLogs(body) {
  const map = new Map(); let n = 0;
  for (const rl of body.resourceLogs || []) {
    const ra = attrs(rl.resource && rl.resource.attributes);
    for (const sl of rl.scopeLogs || []) for (const lr of sl.logRecords || []) {
      const a = Object.assign({}, ra, attrs(lr.attributes));
      const name = String(a["event.name"] || (lr.body && val(lr.body)) || "");
      const session = String(a["session.id"] || a["conversation.id"] || a["conversation_id"] || a["thread.id"] || "");
      if (!session) continue;
      n++;
      const agent = agentOf(a);
      const o = acc(map, session, agent, a);
      if (a.model) o.model = String(a.model);
      // Claude Code：claude_code.api_request（cost_usd、input_tokens…）
      if (/api_request$/.test(name) && ("cost_usd" in a || "input_tokens" in a)) {
        o.cost += num(a.cost_usd); o.tin += num(a.input_tokens) + num(a.cache_read_tokens) + num(a.cache_creation_tokens); o.tout += num(a.output_tokens);
      }
      // Codex：codex.sse_event（response.completed 时带 token 计数）
      else if (/sse_event$/.test(name) && ("input_token_count" in a || "output_token_count" in a)) {
        o.tin += num(a.input_token_count); o.tout += num(a.output_token_count);
      }
    }
  }
  return { records: n, tasks: flush(map, "otel") };
}

export function handleMetrics(body) {
  const map = new Map(); let n = 0;
  for (const rm of body.resourceMetrics || []) {
    const ra = attrs(rm.resource && rm.resource.attributes);
    for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) {
      const data = m.sum || m.gauge; if (!data) continue;
      const cumulative = data.aggregationTemporality === 2 || data.aggregationTemporality === "AGGREGATION_TEMPORALITY_CUMULATIVE";
      for (const dp of data.dataPoints || []) {
        const a = Object.assign({}, ra, attrs(dp.attributes));
        const session = String(a["session.id"] || a["conversation.id"] || "");
        if (!session) continue;
        n++;
        let v = num(dp.asDouble ?? dp.asInt);
        const key = "m:" + session + ":" + m.name + ":" + (a.type || "") + ":" + (a.model || "");
        if (cumulative) { const last = kv.get(key) || 0; kv.set(key, v, 3 * 86400000); v = Math.max(0, v - last); }
        const o = acc(map, session, agentOf(a), a);
        if (a.model) o.model = String(a.model);
        // 只在没有日志事件时，用指标兜底成本（两者都开会重复计算，这里以指标为准时需要关闭日志导出）
        if (m.name === "claude_code.cost.usage" && process.env.OTEL_COST_FROM_METRICS === "1") o.cost += v;
      }
    }
  }
  return { points: n, tasks: flush(map, "otel") };
}
