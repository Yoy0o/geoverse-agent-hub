// 多端同步：本 Hub（通常是本机 Docker）主动与对端 Hub（通常是云端）同步任务、规则、复盘和设置。
// 只有发起方需要配置 HUB_SYNC_*；对端只要开放 /api/sync/* 接口（任何 agent-hub 都有）。
// 每端维护单调递增的变更序号；发起方记住“拉到对端第几号”“推到本端第几号”，每轮只交换增量。
// 写入对端数据时记下来源（src），不会再被推回去；两端都改过的文档按 merge.js 合并，并记入冲突日志。
import crypto from "node:crypto";
import { kv, bus, getDoc, docChanges, putSynced, deleteSynced, getTombstone, currentSeq, transaction, validColl, validId, addEvent } from "#hub/db";
import { config } from "#hub/config";
import { resolveConflict } from "./merge.js";

const nowIso = () => new Date().toISOString();
const key = (d) => d.coll + "/" + d.id;
const PAGE = 500;

export function hubInfo() {
  let id = kv.get("hub:id");
  if (!id) { id = "hub-" + crypto.randomBytes(6).toString("hex"); kv.set("hub:id", id); }
  return { id, name: config.hubName, kind: config.hubKind, version: config.version };
}
const state = () => kv.get("sync:state") || { pulled: -1, pushed: -1, retry: [] };
const saveState = (st) => kv.set("sync:state", st);
export function syncConflicts() { return kv.get("sync:conflicts") || []; }
export function clearConflicts() { kv.del("sync:conflicts"); bus.emit("sync", syncSummary()); }
export function syncSummary() {
  const c = config.sync, st = state();
  return {
    configured: !!(c.url && c.token), url: c.url ? c.url.replace(/^(https?:\/\/[^/]+).*$/, "$1") : "", mode: c.mode, interval: c.interval,
    peer: st.peer || null, last: st.last || null, lastOk: st.lastOk || null, conflicts: syncConflicts().length, pending: (st.retry || []).length,
  };
}

/* ---------------- 对端接口（被别的 Hub 调用） ---------------- */
export function changesFor(since, peer, limit = PAGE) {
  const n = Number(since);
  const page = docChanges({ since: Number.isFinite(n) ? n : -1, notSrc: peer ? String(peer) : null, limit });
  return Object.assign({ hub: hubInfo(), seq: currentSeq() }, page);
}
// 应用发起方推来的文档。base 是发起方拉取时看到的本端序号：之后本端又改过的文档拒收，留给下一轮按冲突合并
export function applyFromPeer(peer, docs) {
  const src = String(peer || "").slice(0, 64);
  if (!src || src === hubInfo().id) throw Object.assign(new Error("bad peer"), { status: 400, expose: true });
  const rejected = []; let applied = 0;
  transaction(() => {
    for (const d of Array.isArray(docs) ? docs.slice(0, 2000) : []) {
      if (!d || !validColl(d.coll) || !validId(String(d.id))) continue;
      if (!d.deleted && (!d.data || typeof d.data !== "object" || Array.isArray(d.data))) continue;
      const cur = getDoc(d.coll, String(d.id)); const tomb = cur ? null : getTombstone(d.coll, String(d.id));
      const curSeq = cur ? cur.seq : tomb ? tomb.seq : -1;
      if (d.base != null && Number.isFinite(Number(d.base)) && curSeq > Number(d.base)) { rejected.push(key(d)); continue; }
      if (d.deleted) deleteSynced(d.coll, String(d.id), src); else putSynced(d.coll, String(d.id), d.data, d.updatedAt, src);
      applied++;
    }
  });
  return { applied, rejected, seq: currentSeq(), hub: hubInfo() };
}

/* ---------------- 发起同步 ---------------- */
function peerClient(c) {
  const headers = { Authorization: "Bearer " + c.token, "Content-Type": "application/json", "User-Agent": "agent-hub-sync/" + config.version };
  if (c.accessId && c.accessSecret) Object.assign(headers, { "CF-Access-Client-Id": c.accessId, "CF-Access-Client-Secret": c.accessSecret });
  return async (path, opts = {}) => {
    let r;
    try { r = await fetch(c.url + path, Object.assign({ headers, redirect: "manual", signal: AbortSignal.timeout(30000) }, opts)); }
    catch (e) { throw new Error("连不上对端 " + c.url + "：" + (e && e.cause && e.cause.code || e.message)); }
    if (r.status >= 300 && r.status < 400) throw new Error("对端要求 Cloudflare Access 认证：检查 HUB_SYNC_ACCESS_CLIENT_ID / HUB_SYNC_ACCESS_CLIENT_SECRET");
    if (r.status === 401) throw new Error("对端拒绝了令牌（401）：HUB_SYNC_TOKEN 应该是对端 Hub 的令牌");
    if (r.status === 403) throw new Error("对端拒绝访问（403）：检查 Access 服务凭证是否在对端白名单里");
    if (!r.ok) throw new Error("对端返回 HTTP " + r.status + "：" + (await r.text().catch(() => "")).slice(0, 200));
    if (!String(r.headers.get("content-type") || "").includes("json")) throw new Error("对端响应不是 Hub JSON（地址是否正确？）");
    return r.json();
  };
}
function localState(k) {
  const [coll, ...rest] = k.split("/"); const id = rest.join("/");
  const d = getDoc(coll, id);
  if (d) return { coll, id, deleted: false, data: d.data, updatedAt: d.updatedAt, seq: d.seq };
  const t = getTombstone(coll, id);
  return t ? { coll, id, deleted: true, data: null, updatedAt: t.at, seq: t.seq } : null;
}
const titleOf = (d) => (d && d.data && (d.data.title || d.data.text || d.data.notes) ? String(d.data.title || d.data.text || d.data.notes).slice(0, 80) : "");

let running = null;
// 同一时间只跑一轮；手动、定时、命令行触发共用
export function syncNow(opts = {}) {
  if (!running) running = runSync(opts).finally(() => { running = null; });
  return running;
}
async function runSync({ dryRun = false } = {}) {
  const c = config.sync;
  if (!c.url || !c.token) throw Object.assign(new Error("未配置多端同步：设置 HUB_SYNC_URL 与 HUB_SYNC_TOKEN"), { status: 400, expose: true });
  const started = Date.now(); const me = hubInfo(); const call = peerClient(c);
  const st = state();
  try {
    const info = await call("/api/sync/info");
    if (!info || !info.id) throw new Error("对端响应不是 Hub 同步接口（版本过旧？对端需要 agent-hub 0.2.0 以上）");
    if (info.id === me.id) throw new Error("HUB_SYNC_URL 指向了本 Hub 自己");
    // 对端换了（例如云端数据重建）：游标作废，从头全量对一遍
    if (st.peer && st.peer.id !== info.id) { st.pulled = -1; st.pushed = -1; st.retry = []; }
    st.peer = { id: info.id, name: info.name, kind: info.kind, version: info.version };

    // 1. 拉取对端增量（排除本端推过去的）
    const remote = []; let remoteSeq = st.pulled ?? -1;
    if (c.mode !== "push") {
      let since = st.pulled ?? -1;
      for (let i = 0; i < 200; i++) {
        const page = await call(`/api/sync/changes?since=${since}&peer=${encodeURIComponent(me.id)}&limit=${PAGE}`);
        remote.push(...page.changes);
        if (page.more && page.changes.length) since = page.changes[page.changes.length - 1].seq;
        else { remoteSeq = page.seq; break; }
      }
    }
    // 2. 本端增量（只取本端产生的修改）+ 上一轮没推成功的
    const localSeq = currentSeq();
    const localMap = new Map();
    if (c.mode !== "pull") {
      let since = st.pushed ?? -1;
      for (let i = 0; i < 200; i++) {
        const page = docChanges({ since, src: "", limit: PAGE });
        page.changes.forEach((d) => localMap.set(key(d), d));
        if (!page.more || !page.changes.length) break;
        since = page.changes[page.changes.length - 1].seq;
      }
      for (const k of st.retry || []) if (!localMap.has(k)) { const d = localState(k); if (d) localMap.set(k, d); }
    }
    // 3. 计划：只有一端改过 → 直接覆盖另一端；两端都改过 → 合并后写两端
    const toLocal = [], toRemote = [], conflicts = [];
    for (const r of remote) {
      const k = key(r); const l = localMap.get(k);
      if (!l) { toLocal.push(r); continue; }
      localMap.delete(k);
      const m = resolveConflict(r.coll, l, r);
      const doc = { coll: r.coll, id: r.id, deleted: m.deleted, data: m.data, updatedAt: m.updatedAt };
      toLocal.push(doc); toRemote.push(doc);
      conflicts.push({ at: nowIso(), coll: r.coll, id: r.id, title: titleOf(l) || titleOf(r), note: m.note, peer: info.name || info.id });
    }
    for (const l of localMap.values()) toRemote.push({ coll: l.coll, id: l.id, deleted: l.deleted, data: l.data, updatedAt: l.updatedAt });
    const base = c.mode === "push" ? null : remoteSeq;
    toRemote.forEach((d) => { d.base = base; });
    if (dryRun) {
      return { dryRun: true, peer: st.peer, pull: toLocal.length, push: toRemote.length, conflicts, keys: { pull: toLocal.map(key).slice(0, 50), push: toRemote.map(key).slice(0, 50) } };
    }

    // 4. 写入本端（来源记为对端，不会被推回去）
    if (toLocal.length) transaction(() => { for (const d of toLocal) d.deleted ? deleteSynced(d.coll, d.id, info.id) : putSynced(d.coll, d.id, d.data, d.updatedAt, info.id); });
    if (c.mode !== "push") st.pulled = remoteSeq;
    saveState(st);
    // 5. 推送到对端；失败或被拒收的下一轮重试
    let rejected = [];
    try {
      for (let i = 0; i < toRemote.length; i += 200) {
        const r = await call("/api/sync/apply", { method: "POST", body: JSON.stringify({ peer: me.id, docs: toRemote.slice(i, i + 200) }) });
        rejected = rejected.concat(r.rejected || []);
      }
    } catch (e) { st.retry = [...new Set(toRemote.map(key).concat(st.retry || []))].slice(0, 5000); throw e; }
    if (c.mode !== "pull") st.pushed = localSeq;
    st.retry = rejected;
    if (conflicts.length) kv.set("sync:conflicts", conflicts.concat(syncConflicts()).slice(0, 50));
    const result = { ok: true, at: nowIso(), ms: Date.now() - started, pulled: toLocal.length, pushed: toRemote.length - rejected.length, conflicts: conflicts.length, rejected: rejected.length };
    st.last = result; st.lastOk = result.at;
    saveState(st);
    if (result.pulled || result.pushed || result.conflicts) {
      addEvent({ agent: "sync", kind: "sync", raw: "sync", summary: `与「${info.name || info.id}」同步：拉取 ${result.pulled} · 推送 ${result.pushed}` + (result.conflicts ? ` · 合并冲突 ${result.conflicts}` : "") });
    }
    bus.emit("sync", syncSummary());
    return Object.assign({ peer: st.peer }, result);
  } catch (e) {
    if (dryRun) throw e;
    st.last = { ok: false, at: nowIso(), ms: Date.now() - started, error: String(e && e.message || e).slice(0, 300) };
    saveState(st);
    bus.emit("sync", syncSummary());
    throw Object.assign(e, { status: e.status || 502, expose: true });
  }
}
