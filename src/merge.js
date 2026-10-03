// 多端同步的冲突合并：同一文档在两端都改过时怎么合（纯函数，不读写数据库）
// 原则：不丢事实。状态历史、退回记录取并集；状态按最后一次流转；回执、评审、检查、执行摘要各取更新的一方；其余字段以后修改的一方为准。
const ts = (v) => Date.parse(v || "") || 0;
const uniqBy = (arr, key) => { const m = new Map(); for (const x of arr) if (x && typeof x === "object") m.set(key(x), x); return [...m.values()]; };
const TERMINAL = ["已合并", "已放弃"];
const newer = (a, b, k = "at") => (ts(a && a[k]) >= ts(b && b[k]) ? a : b);

export function mergeTask(local, remote, localAt, remoteAt) {
  const lt = Math.max(ts(local.updatedAt), ts(localAt)), rt = Math.max(ts(remote.updatedAt), ts(remoteAt));
  const base = lt >= rt ? local : remote, other = base === local ? remote : local;
  const out = Object.assign({}, other, base);
  const history = uniqBy([...(local.history || []), ...(remote.history || [])], (h) => `${h.at}|${h.from || ""}|${h.to || ""}`)
    .sort((a, b) => ts(a.at) - ts(b.at)).slice(-40);
  out.history = history;
  const last = history[history.length - 1];
  if (last && last.to) out.status = last.to;
  const owner = [local, remote].find((x) => x.status === out.status) || base;
  out.reworks = uniqBy([...(local.reworks || []), ...(remote.reworks || [])], (r) => `${r.at}|${r.note || ""}`).sort((a, b) => ts(a.at) - ts(b.at)).slice(-30);
  for (const k of ["receipt", "review", "lastCheck", "exec"]) {
    const v = local[k] && remote[k] ? newer(local[k], remote[k]) : local[k] || remote[k];
    if (v) out[k] = v; else delete out[k];
  }
  // 用量来自各自收到的遥测：取会话更多、成本更高的一份
  const score = (u) => (u ? (u.sessions || 0) * 1e6 + (u.costUsd || 0) * 1e3 + (u.tokensIn || 0) / 1e6 : -1);
  const usageSide = score(local.usage) >= score(remote.usage) ? local : remote;
  if (usageSide.usage) out.usage = usageSide.usage;
  if (!base.costManual && !other.costManual && usageSide.cost != null) out.cost = usageSide.cost;
  // 验收标准：条目相同就合并勾选，否则以后修改的一方为准
  const la = local.acceptance || [], ra = remote.acceptance || [];
  if (la.length && la.length === ra.length && la.every((a, i) => a && ra[i] && a.text === ra[i].text)) {
    out.acceptance = la.map((a, i) => Object.assign({}, a, { done: !!(a.done || ra[i].done) }));
  }
  const started = [local.startedAt, remote.startedAt].filter(Boolean).sort((a, b) => ts(a) - ts(b));
  out.startedAt = started[0] || null;
  if (TERMINAL.includes(out.status)) {
    out.doneAt = owner.doneAt || base.doneAt || (last && last.at) || null;
    if (out.status === "已放弃") { out.dropReason = owner.dropReason || out.dropReason; out.dropNote = owner.dropNote || out.dropNote; }
  } else out.doneAt = null;
  out.updatedAt = new Date(Math.max(lt, rt) || Date.now()).toISOString();
  return out;
}

export function mergeConfig(local, remote, localAt, remoteAt) {
  const lt = ts(localAt), rt = ts(remoteAt);
  const base = lt >= rt ? local : remote, other = base === local ? remote : local;
  const agents = [...new Set([...(base.agents || []), ...(other.agents || [])].map(String).filter(Boolean))];
  const byName = new Map();
  for (const p of other.projects || []) if (p && p.name) byName.set(p.name, p);
  for (const p of base.projects || []) if (p && p.name) byName.set(p.name, Object.assign({}, byName.get(p.name) || {}, p));
  return Object.assign({}, other, base, { agents, projects: [...byName.values()] });
}

/**
 * 两端都改过同一文档时的结果。
 * @param {string} coll
 * @param {{deleted:boolean,data:object,updatedAt:string}} local
 * @param {{deleted:boolean,data:object,updatedAt:string}} remote
 * @returns {{deleted:boolean,data:object|null,updatedAt:string,note:string}}
 */
export function resolveConflict(coll, local, remote) {
  const now = new Date().toISOString();
  if (local.deleted && remote.deleted) return { deleted: true, data: null, updatedAt: now, note: "两端都已删除" };
  // 一端删除、一端修改：保留修改（删除通常是误操作的代价更大）
  if (local.deleted) return { deleted: false, data: remote.data, updatedAt: remote.updatedAt, note: "本端已删除、对端有修改：保留对端版本" };
  if (remote.deleted) return { deleted: false, data: local.data, updatedAt: local.updatedAt, note: "对端已删除、本端有修改：保留本端版本" };
  const lt = ts(local.updatedAt), rt = ts(remote.updatedAt);
  if (coll === "tasks") {
    const data = mergeTask(local.data || {}, remote.data || {}, local.updatedAt, remote.updatedAt);
    return { deleted: false, data, updatedAt: lt >= rt ? local.updatedAt : remote.updatedAt, note: `两端都修改过：合并状态历史与退回记录，状态取最后一次流转（${data.status || "—"}）` };
  }
  if (coll === "config") {
    return { deleted: false, data: mergeConfig(local.data || {}, remote.data || {}, local.updatedAt, remote.updatedAt), updatedAt: lt >= rt ? local.updatedAt : remote.updatedAt, note: "两端都修改过设置：Agent 与项目取并集，同名项目以后修改的一方为准" };
  }
  const win = lt >= rt ? local : remote;
  const data = Object.assign({}, win.data);
  if (coll === "rules") data.hits = Math.max(Number((local.data || {}).hits) || 1, Number((remote.data || {}).hits) || 1);
  return { deleted: false, data, updatedAt: win.updatedAt, note: "两端都修改过：保留" + (win === local ? "本端" : "对端") + "较新的版本" };
}
