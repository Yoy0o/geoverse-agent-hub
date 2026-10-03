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
  CREATE INDEX IF NOT EXISTS ss_last ON sessions(last_at);
  CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER);
  CREATE TABLE IF NOT EXISTS tombstones(
    coll TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, src TEXT NOT NULL DEFAULT '', at TEXT NOT NULL,
    PRIMARY KEY(coll, id));
  CREATE INDEX IF NOT EXISTS tomb_seq ON tombstones(seq);
  CREATE TABLE IF NOT EXISTS runners(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'local', host TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
    agents TEXT NOT NULL DEFAULT '[]', projects TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL DEFAULT 'prepare', max_runs INTEGER NOT NULL DEFAULT 1,
    version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_seen TEXT);
  CREATE TABLE IF NOT EXISTS runs(
    id TEXT PRIMARY KEY, task TEXT NOT NULL, runner TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT 'local',
    host TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'manual', branch TEXT NOT NULL DEFAULT '', worktree TEXT NOT NULL DEFAULT '',
    session TEXT NOT NULL DEFAULT '', progress INTEGER, step TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', exit_code INTEGER,
    cancel INTEGER NOT NULL DEFAULT 0, receipt INTEGER NOT NULL DEFAULT 0, requested_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, claimed_at TEXT, started_at TEXT, heartbeat_at TEXT, ended_at TEXT);
  CREATE INDEX IF NOT EXISTS runs_task ON runs(task, created_at);
  CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at);
  `);
  // 旧库升级：文档的变更序号与来源（多端同步用）
  function columns(table) { try { return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); } catch { return null; } }
  function addColumn(table, col, def) {
    const cols = columns(table);
    if (cols && cols.includes(col)) return;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  }
  addColumn("docs", "seq", "INTEGER NOT NULL DEFAULT 0");
  addColumn("docs", "src", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS docs_seq ON docs(seq)");

  const now = () => new Date().toISOString();
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  /* ---------------- 文档库 ---------------- */
  const stGet = db.prepare("SELECT data, version, updated_at, seq, src FROM docs WHERE coll=? AND id=?");
  const stList = db.prepare("SELECT id, data, version, updated_at FROM docs WHERE coll=? ORDER BY id");
  const stUpsert = db.prepare(`INSERT INTO docs(coll,id,data,version,updated_at,seq,src) VALUES(?,?,?,1,?,?,?)
    ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, version=docs.version+1, updated_at=excluded.updated_at, seq=excluded.seq, src=excluded.src`);
  const stDel = db.prepare("DELETE FROM docs WHERE coll=? AND id=?");
  const stTombPut = db.prepare(`INSERT INTO tombstones(coll,id,seq,src,at) VALUES(?,?,?,?,?)
    ON CONFLICT(coll,id) DO UPDATE SET seq=excluded.seq, src=excluded.src, at=excluded.at`);
  const stTombDel = db.prepare("DELETE FROM tombstones WHERE coll=? AND id=?");
  const stTombGet = db.prepare("SELECT seq, src, at FROM tombstones WHERE coll=? AND id=?");
  // 单调递增的变更序号：每次写文档或删除都取一个新序号，对端按序号增量拉取
  const stSeqBump = db.prepare("INSERT INTO kv(k,v,exp) VALUES('sync:seq','1',NULL) ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(kv.v AS INTEGER)+1 AS TEXT)");
  const stSeqGet = db.prepare("SELECT v FROM kv WHERE k='sync:seq'");
  function nextSeq() { stSeqBump.run(); return Number(stSeqGet.get().v); }
  function currentSeq() { const r = stSeqGet.get(); return r ? Number(r.v) || 0 : 0; }

  const COLLECTIONS = ["tasks", "rules", "retros", "config"];
  function validColl(c) { return COLLECTIONS.includes(c); }
  function validId(id) { return typeof id === "string" && /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) && id !== "." && id !== ".."; }

  function getDoc(coll, id) {
    const r = stGet.get(coll, id);
    return r ? { id, data: parse(r.data) || {}, version: r.version, updatedAt: r.updated_at, seq: r.seq, src: r.src } : null;
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
    stUpsert.run(coll, id, JSON.stringify(body), now(), nextSeq(), "");
    stTombDel.run(coll, id);
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
    if (r.changes) { stTombPut.run(coll, id, nextSeq(), "", now()); emit("doc", { op: "delete", coll, id, origin }); }
    return r.changes > 0;
  }

  /* ---------------- 多端同步：变更日志 ---------------- */
  // 写入对端同步过来的文档：保留对端的修改时间，src 记为对端编号（不会再被推回对端）
  function putSynced(coll, id, data, updatedAt, src) {
    const body = stripDeletes(Object.assign({}, data));
    delete body.id;
    stUpsert.run(coll, id, JSON.stringify(body), updatedAt || now(), nextSeq(), String(src || "peer"));
    stTombDel.run(coll, id);
    const d = getDoc(coll, id);
    emit("doc", { op: "set", coll, id, data: d.data, version: d.version, origin: "sync" });
    return d;
  }
  function deleteSynced(coll, id, src) {
    const r = stDel.run(coll, id);
    stTombPut.run(coll, id, nextSeq(), String(src || "peer"), now());
    if (r.changes) emit("doc", { op: "delete", coll, id, origin: "sync" });
    return r.changes > 0;
  }
  function getTombstone(coll, id) { const r = stTombGet.get(coll, id); return r ? { seq: r.seq, src: r.src, at: r.at } : null; }
  // 按序号列出变更（含删除）。src 指定时只取该来源的变更；notSrc 指定时排除该来源
  function docChanges({ since = -1, src = null, notSrc = null, limit = 500 } = {}) {
    const cond = (alias) => { const w = [`${alias}.seq > ?`], a = [Number(since)]; if (src != null) { w.push(`${alias}.src = ?`); a.push(src); } if (notSrc != null) { w.push(`${alias}.src <> ?`); a.push(notSrc); } return [w.join(" AND "), a]; };
    const [w1, a1] = cond("d"), [w2, a2] = cond("t");
    const n = Math.min(Math.max(1, Number(limit) || 500), 2000);
    const rows = db.prepare(`SELECT * FROM (
        SELECT d.coll AS coll, d.id AS id, d.data AS data, d.updated_at AS at, d.seq AS seq, d.src AS src, 0 AS deleted FROM docs d WHERE ${w1}
        UNION ALL SELECT t.coll, t.id, NULL, t.at, t.seq, t.src, 1 FROM tombstones t WHERE ${w2}
      ) ORDER BY seq LIMIT ?`).all(...a1, ...a2, n + 1);
    const more = rows.length > n;
    return { more, changes: rows.slice(0, n).map((r) => ({ coll: r.coll, id: r.id, deleted: !!r.deleted, data: r.deleted ? null : parse(r.data) || {}, updatedAt: r.at, seq: r.seq, src: r.src })) };
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
  // 只扫描时间窗口内的事件。Cloudflare 按扫描行数计费；不指定索引时规划器会为了 GROUP BY 扫描整个 ev_agent 索引
  function agentStatus(sinceIso) {
    return db.prepare(`SELECT agent, COUNT(*) n_recent, MAX(at) last_at
      FROM events INDEXED BY ev_at WHERE at >= ? AND agent<>'' GROUP BY agent`).all(sinceIso);
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

  /* ---------------- 执行端与执行记录 ---------------- */
  const jarr = (s) => { const v = parse(s); return Array.isArray(v) ? v : []; };
  function rowRunner(r) {
    return r ? { id: r.id, name: r.name, kind: r.kind, host: r.host, platform: r.platform, agents: jarr(r.agents), projects: jarr(r.projects), mode: r.mode, maxRuns: r.max_runs, version: r.version, createdAt: r.created_at, lastSeen: r.last_seen } : null;
  }
  function getRunner(id) { return id ? rowRunner(db.prepare("SELECT * FROM runners WHERE id=?").get(id)) : null; }
  function listRunners() { return db.prepare("SELECT * FROM runners ORDER BY last_seen DESC").all().map(rowRunner); }
  function upsertRunner(r) {
    const t = now();
    db.prepare(`INSERT INTO runners(id,name,kind,host,platform,agents,projects,mode,max_runs,version,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, host=excluded.host, platform=excluded.platform, agents=excluded.agents,
        projects=excluded.projects, mode=excluded.mode, max_runs=excluded.max_runs, version=excluded.version, last_seen=excluded.last_seen`)
      .run(r.id, r.name, r.kind || "local", r.host || "", r.platform || "", JSON.stringify(r.agents || []), JSON.stringify(r.projects || []), r.mode || "prepare", Number(r.maxRuns) || 1, r.version || "", t, t);
    const out = getRunner(r.id);
    emit("runner", out);
    return out;
  }
  function touchRunner(id) {
    const before = getRunner(id); if (!before) return null;
    const t = now();
    db.prepare("UPDATE runners SET last_seen=? WHERE id=?").run(t, id);
    const out = Object.assign({}, before, { lastSeen: t });
    // 心跳很频繁：只在离上次广播超过 60 秒（或刚恢复在线）时推送给网页
    if (!before.lastSeen || Date.parse(t) - Date.parse(before.lastSeen) > 60000) emit("runner", out);
    return out;
  }
  function deleteRunner(id) { const r = db.prepare("DELETE FROM runners WHERE id=?").run(id); if (r.changes) emit("runner", { id, deleted: true }); return r.changes > 0; }

  const RUN_COLS = { task: "task", runner: "runner", agent: "agent", location: "location", host: "host", status: "status", mode: "mode", branch: "branch", worktree: "worktree", session: "session",
    progress: "progress", step: "step", note: "note", exitCode: "exit_code", cancel: "cancel", receipt: "receipt", requestedBy: "requested_by",
    createdAt: "created_at", claimedAt: "claimed_at", startedAt: "started_at", heartbeatAt: "heartbeat_at", endedAt: "ended_at" };
  function rowRun(r) {
    if (!r) return null;
    const o = { id: r.id };
    for (const [k, c] of Object.entries(RUN_COLS)) o[k] = r[c];
    o.cancel = !!r.cancel; o.receipt = !!r.receipt;
    return o;
  }
  const dbVal = (k, v) => (k === "cancel" || k === "receipt" ? (v ? 1 : 0) : v === undefined ? null : v);
  function getRun(id) { return id ? rowRun(db.prepare("SELECT * FROM runs WHERE id=?").get(id)) : null; }
  function insertRun(r) {
    const o = Object.assign({ runner: "", agent: "", location: "local", host: "", status: "queued", mode: "manual", branch: "", worktree: "", session: "", progress: null, step: "", note: "", exitCode: null, cancel: false, receipt: false, requestedBy: "", createdAt: now() }, r);
    const keys = Object.keys(RUN_COLS).filter((k) => o[k] !== undefined);
    db.prepare(`INSERT INTO runs(id,${keys.map((k) => RUN_COLS[k]).join(",")}) VALUES(?,${keys.map(() => "?").join(",")})`).run(o.id, ...keys.map((k) => dbVal(k, o[k])));
    const out = getRun(o.id);
    emit("run", out);
    return out;
  }
  // 更新执行记录；quiet=true 时不推送（纯心跳）
  function updateRun(id, fields, { quiet = false } = {}) {
    const sets = [], args = [];
    for (const [k, v] of Object.entries(fields || {})) if (RUN_COLS[k] && k !== "task") { sets.push(RUN_COLS[k] + "=?"); args.push(dbVal(k, v)); }
    if (!sets.length) return getRun(id);
    db.prepare(`UPDATE runs SET ${sets.join(",")} WHERE id=?`).run(...args, id);
    const out = getRun(id);
    if (out && !quiet) emit("run", out);
    return out;
  }
  function listRuns({ task, runner, statuses, limit = 100, since } = {}) {
    const w = [], a = [];
    if (task) { w.push("task=?"); a.push(task); }
    if (runner) { w.push("runner=?"); a.push(runner); }
    if (statuses && statuses.length) { w.push(`status IN (${statuses.map(() => "?").join(",")})`); a.push(...statuses); }
    if (since) { w.push("COALESCE(ended_at, heartbeat_at, created_at) >= ?"); a.push(since); }
    a.push(Math.min(Math.max(1, Number(limit) || 100), 1000));
    return db.prepare(`SELECT * FROM runs ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`).all(...a).map(rowRun);
  }
  function pruneRuns(days) {
    const cut = new Date(Date.now() - days * 86400000).toISOString();
    return db.prepare("DELETE FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?").run(cut).changes;
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
    return { docs: c("docs"), events: c("events"), sessions: c("sessions"), runs: c("runs"), runners: c("runners") };
  }

  return { bus, COLLECTIONS, validColl, validId, getDoc, listDocs, setDoc, updateDoc, deleteDoc, transaction, addEvent, listEvents, pruneEvents, agentStatus, channelStatus, getSession, touchSession, bumpSession, sessionsForTask, sessionsSince, kv, stats,
    currentSeq, putSynced, deleteSynced, getTombstone, docChanges,
    getRunner, listRunners, upsertRunner, touchRunner, deleteRunner, getRun, insertRun, updateRun, listRuns, pruneRuns };
}
