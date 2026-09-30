// 把原 Artifact 工作台依赖的 window.claude 能力（db / downloads / sample）接到 agent-hub 的 REST + SSE 上。
// 页面代码几乎不用改：db.collection(x).onSnapshot、db.doc(p).set/update/delete、downloads.save、sample(...)。
(function () {
  "use strict";
  const H = { "X-Requested-With": "agent-hub" };
  let loginShown = false;

  function codeFor(status, j) {
    if (j && j.code) return j.code;
    if (status === 401) return "revoked";
    if (status === 413) return "quota_exceeded";
    if (status === 429) return "resource_exhausted";
    return "invalid_argument";
  }
  async function req(method, url, body) {
    const opts = { method, credentials: "same-origin", headers: Object.assign({}, H) };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    if (r.status === 401) { showLogin(); throw Object.assign(new Error("unauthorized"), { code: "revoked" }); }
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) throw Object.assign(new Error((data && data.error) || String(r.status)), { code: codeFor(r.status, data), status: r.status });
    return data;
  }

  /* ---------- 登录 ---------- */
  function showLogin() {
    if (loginShown) return; loginShown = true;
    const el = document.createElement("div");
    el.className = "modal";
    el.innerHTML = '<form class="box" style="grid-template-rows:auto auto auto" id="hub-login"><header>登录 agent-hub</header>' +
      '<div><p class="hint">输入 HUB_TOKEN（本地运行 node src/cli.js token 查看；Cloudflare 使用部署时设置的密钥）。</p>' +
      '<input type="password" id="hub-token" autocomplete="current-password" placeholder="ah_…" style="width:100%"><p class="hint bad" id="hub-login-err" hidden></p></div>' +
      '<footer class="btns"><button class="btn pri" type="submit">登录</button></footer></form>';
    document.body.appendChild(el);
    const f = el.querySelector("#hub-login");
    setTimeout(() => el.querySelector("#hub-token").focus(), 50);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = el.querySelector("#hub-token").value.trim();
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      if (r.ok) location.reload();
      else { const m = el.querySelector("#hub-login-err"); m.hidden = false; m.textContent = r.status === 429 ? "尝试次数过多，稍后再试" : "令牌不对"; }
    });
  }

  /* ---------- 文档库 + 实时推送 ---------- */
  const colls = {};          // name -> Map(id -> data)
  const loading = {};        // name -> Promise
  const subs = new Set();    // {name, id?, cb}
  const snapColl = (name) => ({ docs: Array.from((colls[name] || new Map()).entries()).map(([id, d]) => ({ id, exists: true, data: () => d })) });
  const snapDoc = (name, id) => { const d = colls[name] && colls[name].get(id); return { id, exists: !!d, data: () => d }; };
  function notify(name, id) { subs.forEach((s) => { if (s.name !== name) return; if (!s.id) s.cb(snapColl(name)); else if (s.id === id) s.cb(snapDoc(name, id)); }); }
  function load(name, force) {
    if (!force && loading[name]) return loading[name];
    loading[name] = req("GET", "/api/docs/" + encodeURIComponent(name)).then((list) => { const m = new Map(); list.forEach((d) => m.set(d.id, d.data)); colls[name] = m; return m; });
    return loading[name];
  }
  let es = null, opened = 0;
  function stream() {
    if (es) return;
    es = new EventSource("/api/stream");
    es.addEventListener("doc", (e) => {
      const d = JSON.parse(e.data); const m = colls[d.coll]; if (!m) return;
      if (d.op === "delete") m.delete(d.id); else m.set(d.id, d.data);
      notify(d.coll, d.id);
    });
    es.addEventListener("agent-event", (e) => { try { window.dispatchEvent(new CustomEvent("hub:event", { detail: JSON.parse(e.data) })); } catch (x) { /* 忽略 */ } });
    es.addEventListener("open", () => {
      window.dispatchEvent(new CustomEvent("hub:online", { detail: true }));
      if (opened++ === 0) return;
      // 断线重连：全量重新同步
      Object.keys(colls).forEach((n) => load(n, true).then(() => { notify(n); (colls[n] ? Array.from(colls[n].keys()) : []).forEach((id) => notify(n, id)); }).catch(() => {}));
    });
    es.addEventListener("error", () => window.dispatchEvent(new CustomEvent("hub:online", { detail: false })));
  }
  function split(p) { const i = p.indexOf("/"); return [p.slice(0, i), p.slice(i + 1)]; }
  function applyLocal(name, id, data) { if (!colls[name]) return; if (data === null) colls[name].delete(id); else colls[name].set(id, data); notify(name, id); }
  const db = {
    collection(name) {
      return {
        onSnapshot(cb, onErr) {
          const s = { name, cb }; subs.add(s); stream();
          load(name).then(() => cb(snapColl(name))).catch((e) => onErr && onErr(e));
          return () => subs.delete(s);
        },
      };
    },
    doc(path) {
      const [name, id] = split(path);
      const url = "/api/docs/" + encodeURIComponent(name) + "/" + encodeURIComponent(id);
      return {
        set: (body) => req("PUT", url, body).then((d) => applyLocal(name, id, d.data)),
        update: (patch) => req("PATCH", url, patch).then((d) => applyLocal(name, id, d.data)),
        delete: () => req("DELETE", url).then(() => applyLocal(name, id, null)),
        onSnapshot(cb, onErr) {
          const s = { name, id, cb }; subs.add(s); stream();
          load(name).then(() => cb(snapDoc(name, id))).catch((e) => onErr && onErr(e));
          return () => subs.delete(s);
        },
      };
    },
  };

  /* ---------- 下载 ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.json$/.test(filename) ? "application/json" : "text/plain;charset=utf-8" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
  };

  /* ---------- LLM 辅助（hub 配了 LLM_* 才可用） ---------- */
  async function sample(prompt, opts = {}) {
    const r = await fetch("/api/sample", { method: "POST", credentials: "same-origin", signal: opts.signal, headers: Object.assign({ "Content-Type": "application/json" }, H), body: JSON.stringify({ prompt, stream: true }) })
      .catch((e) => { throw Object.assign(new Error("cancelled"), { code: opts.signal && opts.signal.aborted ? "cancelled" : "network" }); });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || r.status), { code: r.status === 501 ? "sampling_disabled" : j.code || "upstream_error" }); }
    const rd = r.body.getReader(); const dec = new TextDecoder(); let text = "";
    try {
      for (;;) { const { value, done } = await rd.read(); if (done) break; text += dec.decode(value, { stream: true }); if (opts.onText) opts.onText({ text }); }
    } catch (e) { throw Object.assign(new Error("cancelled"), { code: "cancelled", text }); }
    return { text };
  }
  sample.json = async (prompt) => {
    const r = await fetch("/api/sample", { method: "POST", credentials: "same-origin", headers: Object.assign({ "Content-Type": "application/json" }, H), body: JSON.stringify({ prompt, json: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.status), { code: r.status === 501 ? "sampling_disabled" : j.code || "upstream_error" });
    return j.json;
  };

  let capsP = null;
  const caps = () => (capsP = capsP || req("GET", "/api/capabilities"));
  window.hub = { req, caps, showLogin };
  window.claude = {
    async use(name) {
      const c = await caps();
      if (name === "db") return db;
      if (name === "downloads") return downloads;
      if (name === "sample") { if (c.sample) return sample; throw Object.assign(new Error("sampling_disabled"), { code: "sampling_disabled" }); }
      throw Object.assign(new Error("not_declared"), { code: "not_declared" });
    },
  };
})();
