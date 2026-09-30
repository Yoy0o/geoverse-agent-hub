// 可选的 LLM 辅助：网页里“让 Claude 解析回执 / 提炼规则 / 起草复盘”在自托管环境下走这里
// 支持 Anthropic Messages API，或任何 OpenAI 兼容的 Chat Completions 接口（DeepSeek、通义、Kimi、本地 vLLM 等）
import { config } from "#hub/config";

export function llmEnabled() { return !!(config.llm.provider && config.llm.apiKey && config.llm.model); }

function extractJson(s) {
  const t = String(s || "").trim();
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const i = Math.min(...["{", "["].map((c) => { const k = body.indexOf(c); return k < 0 ? Infinity : k; }));
  if (!Number.isFinite(i)) throw Object.assign(new Error("invalid_json"), { code: "invalid_json" });
  const open = body[i], close = open === "{" ? "}" : "]";
  const j = body.lastIndexOf(close);
  return JSON.parse(body.slice(i, j + 1));
}

async function* streamAnthropic(prompt, signal) {
  const base = config.llm.baseUrl || "https://api.anthropic.com";
  const r = await fetch(base + "/v1/messages", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-api-key": config.llm.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: config.llm.model, max_tokens: 2048, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw Object.assign(new Error("upstream " + r.status + " " + (await r.text()).slice(0, 300)), { status: r.status });
  for await (const ev of sse(r.body)) {
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") yield ev.delta.text;
  }
}
async function* streamOpenAI(prompt, signal) {
  const base = config.llm.baseUrl || "https://api.openai.com/v1";
  const r = await fetch(base + "/chat/completions", {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: "Bearer " + config.llm.apiKey },
    body: JSON.stringify({ model: config.llm.model, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw Object.assign(new Error("upstream " + r.status + " " + (await r.text()).slice(0, 300)), { status: r.status });
  for await (const ev of sse(r.body)) {
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta; if (d && d.content) yield d.content;
  }
}
async function* sse(body) {
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch { /* 忽略 */ }
    }
  }
}

// POST /api/sample {prompt, json?:bool, stream?:bool}
export async function sampleRoute(req, res) {
  if (!llmEnabled()) return res.status(501).json({ error: "sampling_disabled", code: "sampling_disabled" });
  const { prompt, json: wantJson, stream } = req.body || {};
  if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "prompt required" });
  if (prompt.length > 200000) return res.status(413).json({ error: "prompt_too_large", code: "prompt_too_large" });
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
  const gen = config.llm.provider === "anthropic" ? streamAnthropic : streamOpenAI;
  const p = wantJson ? prompt + "\n\n只输出 JSON，不要任何解释或代码块标记。" : prompt;
  try {
    if (stream && !wantJson) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      for await (const piece of gen(p, ctl.signal)) res.write(piece);
      return res.end();
    }
    let text = "";
    for await (const piece of gen(p, ctl.signal)) text += piece;
    if (wantJson) {
      try { return res.json({ json: extractJson(text) }); } catch { return res.status(422).json({ error: "invalid_json", code: "invalid_json", text }); }
    }
    res.json({ text });
  } catch (e) {
    if (ctl.signal.aborted) return;
    const code = e.status === 429 ? "rate_limited" : "upstream_error";
    if (!res.headersSent) res.status(502).json({ error: String(e.message || e).slice(0, 400), code });
    else res.end();
  }
}
