// Shared synchronous storage operations for Node SQLite and Durable Objects SQLite.
import { EventEmitter } from "node:events";

export function createStore(db) {
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  let pendingEvents = null;
  const emit = (type, value) => pendingEvents ? pendingEvents.push([type, value]) : bus.emit(type, value);

  db.exec(`
  CREATE TABLE IF NOT EXISTS docs(
    coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    PRIMARY KEY(coll, id));
  CREATE TABLE IF NOT EXISTS events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
    agent TEXT, kind TEXT, raw TEXT, task TEXT, session TEXT,
    repo TEXT, branch TEXT, summary TEXT, data TEXT);
  CREATE INDEX IF NOT EXISTS ev_task ON events(task, seq);
  CREATE INDEX IF NOT EXISTS ev_at ON events(at);
  CREATE INDEX IF NOT EXISTS ev_agent ON events(agent, seq);
  CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY, agent TEXT, task TEXT, repo TEXT, cwd TEXT, model TEXT,
    started_at TEXT, ended_at TEXT, last_at TEXT,
    cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0, edits INTEGER NOT NULL DEFAULT 0, denies INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0, channels TEXT NOT NULL DEFAULT '');
  CREATE INDEX IF NOT EXISTS ss_task ON sessions(task);
  CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER);
  `);

  const now = () => new Date().toISOString();
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  /* ---------------- 文档库 ---------------- */
  const stGet = db.prepare("SELECT data, version, updated_at FROM docs WHERE coll=? AND id=?");
  const stList = db.prepare("SELECT id, data, version, updated_at FROM docs WHERE coll=? ORDER BY id");
  const stUpsert = db.prepare(`INSERT INTO docs(coll,id,data,version,updated_at) VALUES(?,?,?,1,?)
    ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, version=docs.version+1, updated_at=excluded.updated_at`);
  const stDel = db.prepare("DELETE FROM docs WHERE coll=? AND id=?");

  const COLLECTIONS = ["tasks", "rules", "retros", "config"];
  function validColl(c) { return COLLECTIONS.includes(c); }
  function validId(id) { return typeof id === "string" && /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) && id !== "." && id !== ".."; }

  function getDoc(coll, id) {
    const r = stGet.get(coll, id);
    return r ? { id, data: parse(r.data) || {}, version: r.version, updatedAt: r.updated_at } : null;
  }
  function listDocs(coll) {
    return stList.all(coll).map((r) => ({ id: r.id, data: parse(r.data) || {}, version: r.version, updatedAt: r.updated_at }));
  }
  function stripDeletes(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && v.__delete__ === true) continue;
      out[k] = v;
    }
    return out;
  }
  function setDoc(coll, id, data, origin = "api") {
    const body = stripDeletes(Object.assign({}, data));
    delete body.id;
    stUpsert.run(coll, id, JSON.stringify(body), now());
    const d = getDoc(coll, id);
    emit("doc", { op: "set", coll, id, data: d.data, version: d.version, origin });
    return d;
  }
  // 浅合并；值为 {__delete__:true} 的字段会被删除（与 Artifact 数据库语义一致）
  function updateDoc(coll, id, patch, origin = "api") {
    const cur = getDoc(coll, id);
    if (!cur) return null;
    const next = Object.assign({}, cur.data);
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "id") continue;
      if (v && typeof v === "object" && !Array.isArray(v) && v.__delete__ === true) delete next[k];
      else next[k] = v;
    }
    return setDoc(coll, id, next, origin);
  }
  function deleteDoc(coll, id, origin = "api") {
    const r = stDel.run(coll, id);
    if (r.changes) emit("doc", { op: "delete", coll, id, origin });
    return r.changes > 0;
  }
  function transaction(fn) {
    if (pendingEvents) return fn();
    const events = [];
    pendingEvents = events;
    const run = () => {
      const result = fn();
      if (result && typeof result.then === "function") throw new Error("Storage transactions must be synchronous");
      return result;
    };
    let result;
    try {
      if (db.transactionSync) result = db.transactionSync(run);
      else {
        db.exec("BEGIN");
        try { result = run(); db.exec("COMMIT"); }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    } finally { pendingEvents = null; }
    for (const [type, value] of events) bus.emit(type, value);
    return result;
  }

  /* ---------------- 事件 ---------------- */
  const stEv = db.prepare(`INSERT INTO events(at,agent,kind,raw,task,session,repo,branch,summary,data) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  function addEvent(e) {
    const at = e.at || now();
    const data = e.data == null ? null : JSON.stringify(e.data);
    const r = stEv.run(at, e.agent || "", e.kind || "other", e.raw || "", e.task || null, e.session || null, e.repo || "", e.branch || "", (e.summary || "").slice(0, 500), data);
    const ev = { seq: Number(r.lastInsertRowid), at, agent: e.agent || "", kind: e.kind || "other", raw: e.raw || "", task: e.task || null, session: e.session || null, repo: e.repo || "", branch: e.branch || "", summary: (e.summary || "").slice(0, 500) };
    emit("event", ev);
    return ev;
  }
  function rowEv(r) { return { seq: r.seq, at: r.at, agent: r.agent, kind: r.kind, raw: r.raw, task: r.task, session: r.session, repo: r.repo, branch: r.branch, summary: r.summary, data: r.data ? parse(r.data) : null }; }
  function listEvents({ task, agent, since, limit = 100, withData = false } = {}) {
    const w = [], a = [];
    if (task) { w.push("task=?"); a.push(task); }
    if (agent) { w.push("agent=?"); a.push(agent); }
    if (since) { w.push("at>=?"); a.push(since); }
    const sql = `SELECT * FROM events ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`;
    a.push(Math.min(Math.max(1, Number(limit) || 100), 1000));
    return db.prepare(sql).all(...a).map((r) => { const e = rowEv(r); if (!withData) delete e.data; return e; });
  }
  function pruneEvents(days) {
    const cut = new Date(Date.now() - days * 86400000).toISOString();
    return db.prepare("DELETE FROM events WHERE at < ?").run(cut).changes;
  }
  function agentStatus(sinceIso) {
    return db.prepare(`SELECT agent, COUNT(*) n, MAX(at) last_at,
        SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) n_recent,
        GROUP_CONCAT(DISTINCT kind) kinds
      FROM events WHERE agent<>'' GROUP BY agent`).all(sinceIso);
  }
  function channelStatus() {
    return db.prepare(`SELECT agent, raw, MAX(at) last_at FROM events WHERE agent<>'' AND kind IN ('mcp','otel') GROUP BY agent, raw`).all();
  }

  /* ---------------- 会话 ---------------- */
  const stSessGet = db.prepare("SELECT * FROM sessions WHERE id=?");
  function getSession(id) { return id ? stSessGet.get(id) || null : null; }
  function touchSession(id, fields = {}) {
    if (!id) return null;
    const cur = getSession(id);
    const t = fields.at || now();
    if (!cur) {
      db.prepare(`INSERT INTO sessions(id,agent,task,repo,cwd,model,started_at,last_at,channels) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(id, fields.agent || "", fields.task || null, fields.repo || "", fields.cwd || "", fields.model || "", t, t, fields.channel || "");
    } else {
      const ch = new Set(String(cur.channels || "").split(",").filter(Boolean));
      if (fields.channel) ch.add(fields.channel);
      db.prepare(`UPDATE sessions SET agent=COALESCE(NULLIF(?,''),agent), task=COALESCE(?,task), repo=COALESCE(NULLIF(?,''),repo),
          cwd=COALESCE(NULLIF(?,''),cwd), model=COALESCE(NULLIF(?,''),model), last_at=?, channels=? WHERE id=?`)
        .run(fields.agent || "", fields.task || null, fields.repo || "", fields.cwd || "", fields.model || "", t, [...ch].join(","), id);
    }
    return getSession(id);
  }
  function bumpSession(id, deltas) {
    if (!id || !getSession(id)) return;
    const cols = ["cost_usd", "tokens_in", "tokens_out", "tool_calls", "edits", "denies", "turns"];
    const sets = [], args = [];
    for (const c of cols) if (deltas[c]) { sets.push(`${c}=${c}+?`); args.push(deltas[c]); }
    if (deltas.ended_at) { sets.push("ended_at=?"); args.push(deltas.ended_at); }
    if (!sets.length) return;
    args.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(",")} WHERE id=?`).run(...args);
  }
  function sessionsForTask(task) {
    return db.prepare("SELECT * FROM sessions WHERE task=? ORDER BY started_at").all(task);
  }
  function sessionsSince(sinceIso) {
    return db.prepare("SELECT * FROM sessions WHERE last_at>=? ORDER BY last_at DESC").all(sinceIso);
  }

  /* ---------------- KV ---------------- */
  const kv = {
    get(k) { const r = db.prepare("SELECT v, exp FROM kv WHERE k=?").get(k); if (!r) return null; if (r.exp && r.exp < Date.now()) { this.del(k); return null; } return parse(r.v); },
    set(k, v, ttlMs) { db.prepare("INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp").run(k, JSON.stringify(v), ttlMs ? Date.now() + ttlMs : null); },
    del(k) { db.prepare("DELETE FROM kv WHERE k=?").run(k); },
    prune() { db.prepare("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?").run(Date.now()); },
  };

  function stats() {
    const c = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    return { docs: c("docs"), events: c("events"), sessions: c("sessions") };
  }

  return { bus, COLLECTIONS, validColl, validId, getDoc, listDocs, setDoc, updateDoc, deleteDoc, transaction, addEvent, listEvents, pruneEvents, agentStatus, channelStatus, getSession, touchSession, bumpSession, sessionsForTask, sessionsSince, kv, stats };
}
