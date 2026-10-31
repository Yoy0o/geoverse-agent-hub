// Immutable delivery snapshots and review bindings, shared by every transport.
import crypto from "node:crypto";

const hash = x => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const arr = x => Array.isArray(x) ? x : [];
const text = x => typeof x === "string" ? x : "";
const error = (message, status = 409) => Object.assign(new Error(message), { status, expose: true });
const cleanScope = x => !x || /^(ok|无|none|没有)$/i.test(x.trim());
const chronological = (a, b) => a.at.localeCompare(b.at) || (a.sequence || 0) - (b.sequence || 0) || a.id.localeCompare(b.id);
export const DELIVERY_FIELDS = ["deliveries", "currentDelivery", "deliveryChecks", "deliveryReviews", "receipt", "review", "reworks", "lastCheck"];

export function requirementsOf(t) {
  return { goal: text(t.goal), allow: text(t.allow), deny: text(t.deny), spec: text(t.spec), acceptance: arr(t.acceptance).map(a => text(a?.text)) };
}
export const requirementsHash = t => hash(requirementsOf(t));
export function deliveryHistory(t) {
  if (arr(t.deliveries).length) return t.deliveries;
  if (!t.receipt) return [];
  return [{ id: "legacy-" + hash(t.receipt).slice(0, 24), at: t.receipt.at || t.updatedAt || t.createdAt || "", by: t.receipt.by || "unknown",
    legacy: true, receipt: t.receipt, version: "", run: "", requirements: null, requirementsHash: "", archivedReason: "" }];
}
export function currentDelivery(t) {
  const all = deliveryHistory(t);
  return all.find(r => r.id === t.currentDelivery) || (!t.currentDelivery && all.length === 1 && all[0].legacy ? all[0] : null);
}
function checkFor(t, revision) {
  if (!revision) return null;
  return arr(t.deliveryChecks).filter(c => !c.dirty && c.requirementsHash === revision.requirementsHash && (c.deliveryId === revision.id || (!c.deliveryId && c.version && c.version === revision.version)))
    .sort(chronological).at(-1) || null;
}
export function deliveryDifference(previous, current) {
  if (!current) return null;
  const before = previous?.receipt || {}, after = current.receipt;
  const bv = new Map(arr(before.verify).map(v => [v.cmd, v.result])), av = new Map(arr(after.verify).map(v => [v.cmd, v.result]));
  return { first: !previous, summary: before.summary === after.summary ? null : { before: before.summary || "", after: after.summary },
    addedFiles: arr(after.changed).filter(f => !arr(before.changed).includes(f)), removedFiles: arr(before.changed).filter(f => !arr(after.changed).includes(f)),
    verification: [...new Set([...bv.keys(), ...av.keys()])].filter(cmd => bv.get(cmd) !== av.get(cmd)).map(cmd => ({ cmd, before: bv.get(cmd) || "未上报", after: av.get(cmd) || "未上报" })),
    requirementsChanged: !!previous && previous.requirementsHash !== current.requirementsHash,
    versionChanged: !!previous && previous.version !== current.version };
}
export function deliveryContext(t, selectedId = "") {
  const history = deliveryHistory(t).slice().sort(chronological), active = currentDelivery(t);
  const selected = selectedId ? history.find(r => r.id === selectedId) : active;
  if (selectedId && !selected) throw error("找不到成果版本", 404);
  const check = checkFor(t, selected), requirementsChanged = !!selected && selected.requirementsHash !== requirementsHash(t);
  const blockers = [], warnings = [];
  if (!selected || selected.legacy) blockers.push("请提交带成果版本的回执；旧回执没有可靠的验收绑定");
  if (selected && (!selected.version || /^(unknown|n\/a|未知|未说明|<.*>)$/i.test(selected.version))) blockers.push("缺少成果版本，请补交实际提交号或文档版本");
  if (selected && requirementsChanged && !selected.legacy) blockers.push("目标、范围或验收标准已有变化，请按新要求重新交付");
  if (selected?.receipt.status === "blocked" || arr(selected?.receipt.verify).some(v => v.result === "fail")) blockers.push("这版回执包含阻塞或失败的验证");
  if (selected && !cleanScope(selected.receipt.scope)) blockers.push("这版回执包含未解决的越界声明");
  if (check && (check.ok !== true || arr(check.verify).some(v => v.result === "fail") || arr(check.outOfScope).length)) blockers.push("绑定这版成果的检查未通过");
  if (!check) warnings.push("没有绑定这版成果的机器检查；回执验证仅代表上报结果");
  if (!arr(selected?.receipt.verify).length || arr(selected?.receipt.verify).some(v => v.result === "unknown")) warnings.push("存在未验证或未说明的验证项");
  if (selected?.receipt.risks && !/^(无|none|ok|没有)$/i.test(selected.receipt.risks.trim())) warnings.push("仍有已知风险：" + selected.receipt.risks);
  if (t.lastCheck && (!check || t.lastCheck.id !== check.id)) warnings.push("最近一次检查未绑定当前成果，不作为本次验收依据");
  const fingerprint = hash({ status: t.status, revision: active?.id || null, requirements: requirementsHash(t), check: checkFor(t, active), receipt: active?.receipt || null });
  const latestReview = arr(t.deliveryReviews).filter(r => r.deliveryId === active?.id).sort(chronological).at(-1) || null;
  const accepted = !!active && t.status === "已合并" && latestReview?.action === "merge" && latestReview.requirementsHash === requirementsHash(t)
    && latestReview.checkId === (checkFor(t, active)?.id || "");
  const at = history.findIndex(r => r.id === selected?.id);
  return { task: t.id, status: t.status, currentId: active?.id || null, expectedFingerprint: fingerprint, selected: selected || null, check,
    difference: deliveryDifference(history.find(r => r.id === selected?.parentId) || history.slice(0, at).filter(r => !r.archivedReason).at(-1), selected), requirementsChanged,
    blockers, warnings, canReview: t.status === "待评审" && selected?.id === active?.id && !blockers.length,
    accepted, latestReview, archivedCount: history.filter(r => r.archivedReason && r.id !== active?.id).length, reviews: arr(t.deliveryReviews).filter(r => r.deliveryId === selected?.id),
    versions: history.slice().reverse().map((r, i) => ({ id: r.id, number: history.length - i, at: r.at, by: r.by, version: r.version, summary: r.receipt.summary, legacy: !!r.legacy, archivedReason: r.archivedReason, current: r.id === active?.id })) };
}
export function versionReceipt(t, receipt, by, run = "", archivedReason = "") {
  if (!text(receipt.summary).trim() || receipt.summary.length > 4000) throw error("回执结论不能为空，且不能超过 4000 字", 400);
  const history = deliveryHistory(t), requirements = requirementsOf(t), reqHash = hash(requirements);
  const normalized = { status: receipt.status || "done", summary: text(receipt.summary), changed: arr(receipt.changed).slice(0, 200), verify: arr(receipt.verify).slice(0, 50), scope: text(receipt.scope), risks: text(receipt.risks), version: text(receipt.version).trim().slice(0, 100) };
  // Independent of transport, agent label, receipt formatting, telemetry and arrival time.
  const key = hash({ task: t.id, receipt: normalized, run, requirementsHash: reqHash });
  const duplicate = history.find(r => r.id === "D-" + key.slice(0, 24));
  if (duplicate) return { duplicate: true, revision: duplicate };
  const at = new Date().toISOString();
  const revision = { id: "D-" + key.slice(0, 24), at, sequence: history.length + 1, parentId: currentDelivery(t)?.id || "", by, receipt: normalized, version: normalized.version, run, requirements, requirementsHash: reqHash, archivedReason };
  return { revision, patch: { deliveries: history.concat([revision]), ...(archivedReason ? {} : { currentDelivery: revision.id,
    receipt: { ...normalized, at, by, hash: receipt.hash || "", deliveryId: revision.id }, acceptance: arr(t.acceptance).map(a => ({ ...a, done: false })) }) } };
}
export function recordCheck(t, input, by) {
  const deliveryId = text(input.deliveryId), version = text(input.version).trim().slice(0, 100), target = deliveryId && deliveryHistory(t).find(r => r.id === deliveryId);
  if (deliveryId && !target) throw error("检查引用的成果版本不存在", 400);
  if (target && version && target.version !== version) throw error("检查的成果版本与指定回执不一致");
  if (target && input.dirty) throw error("存在未提交修改，检查不能绑定已交付的提交");
  const at = new Date().toISOString();
  const check = { id: "C-" + crypto.randomUUID(), at, sequence: arr(t.deliveryChecks).length + 1, by, deliveryId, version, requirementsHash: target ? target.requirementsHash : requirementsHash(t), dirty: input.dirty === true,
    ok: input.ok === true, verify: arr(input.verify).slice(0, 50).map(v => ({ cmd: text(v?.cmd), result: ["pass", "fail"].includes(v?.result) ? v.result : "unknown" })),
    outOfScope: arr(input.outOfScope).map(String).slice(0, 200), changed: arr(input.changed).map(String).slice(0, 500), added: Number(input.added) || 0, removed: Number(input.removed) || 0 };
  return { check, patch: { lastCheck: check, deliveryChecks: arr(t.deliveryChecks).concat([check]) } };
}
export function bindReview(t, action, input, by) {
  const v = deliveryContext(t), r = v.selected;
  if (input.expectedDeliveryId !== r?.id || input.expectedFingerprint !== v.expectedFingerprint) throw error("成果或验收依据已有变化，请重新读取版本后再评审；本次未写入");
  if (t.status !== "待评审") throw error("请先将任务提交评审，再验收或退回这版成果");
  if (action === "merge") {
    if (v.blockers.length) throw error(v.blockers.join("；"));
    if (input.verificationConfirmed !== true) throw error("请明确确认已核对这版成果与验证依据");
    const accepted = arr(input.acceptedCriteria);
    if (accepted.some(i => !Number.isInteger(i) || i < 0 || i >= r.requirements.acceptance.length) || r.requirements.acceptance.some((_, i) => !accepted.includes(i))) throw error("请逐项确认这版成果的验收标准");
    if (v.warnings.length && !text(input.note).trim()) throw error("仍有未验证项或风险，请在评审备注说明人工核对结果与接受理由");
  }
  return { id: "R-" + crypto.randomUUID(), at: new Date().toISOString(), sequence: arr(t.deliveryReviews).length + 1, by, action, deliveryId: r.id, version: r.version,
    requirementsHash: requirementsHash(t), checkId: v.check?.id || "", fingerprint: v.expectedFingerprint,
    acceptance: action === "merge" ? r.requirements.acceptance.slice() : [], verificationConfirmed: input.verificationConfirmed === true,
    reasons: arr(input.reasons).map(String).slice(0, 10), note: text(input.note).trim().slice(0, 2000) };
}
