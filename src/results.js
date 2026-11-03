// A read-only, bounded index of task delivery facts. No inferred links or model calls.
import { z } from "zod";
import { currentDelivery, deliveryContext, deliveryHistory, hasDeliveryVersion } from "./delivery.js";

export const searchShape = {
  q: z.string().trim().max(200).default(""), project: z.string().trim().max(200).default(""),
  scope: z.enum(["accepted", "current", "all"]).default("accepted"),
  limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0),
};
const normalize = s => String(s || "").normalize("NFKC").toLowerCase();
const concise = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 280);
export function searchDeliveries(tasks, input = {}) {
  const parsed = z.object(searchShape).strict().safeParse(input);
  if (!parsed.success) throw Object.assign(new Error("搜索参数无效：" + parsed.error.issues.map(e => e.message).join("；")), { status: 400, expose: true });
  const query = parsed.data, terms = normalize(query.q).split(/\s+/u).filter(Boolean), rows = [];
  for (const t of tasks) {
    if (query.project && t.project !== query.project) continue;
    const active = currentDelivery(t), accepted = active && deliveryContext(t).accepted;
    for (const d of deliveryHistory(t)) {
      const current = d.id === active?.id, approved = !!accepted && current;
      if ((query.scope === "accepted" && !approved) || (query.scope === "current" && !current)) continue;
      const fields = { "任务": t.title + " " + t.id, "项目": t.project, "结论": d.receipt.summary, "版本": d.version + " " + d.id,
        "文件": (d.receipt.changed || []).join(" "), "目标与验收": [d.requirements?.goal, ...(d.requirements?.acceptance || [])].join(" "),
        "验证": (d.receipt.verify || []).map(v => v.cmd).join(" ") };
      const searchable = Object.entries(fields).map(([label, value]) => [label, normalize(value)]);
      if (!terms.every(term => searchable.some(([, value]) => value.includes(term)))) continue;
      const matchedOn = terms.length ? searchable.filter(([, value]) => terms.some(term => value.includes(term))).map(([label]) => label) : [];
      const verify = d.receipt.verify || [];
      rows.push({ taskId: t.id, title: t.title, project: t.project || "", taskStatus: t.status, deliveryId: d.id, version: d.version,
        summary: concise(d.receipt.summary), at: d.at, current, accepted: approved, legacy: !!d.legacy, reusable: !d.legacy && hasDeliveryVersion(d.version), archivedReason: d.archivedReason || "", matchedOn,
        verification: { pass: verify.filter(v => v.result === "pass").length, fail: verify.filter(v => v.result === "fail").length, unknown: verify.filter(v => !["pass", "fail"].includes(v.result)).length } });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at) || a.taskId.localeCompare(b.taskId) || a.deliveryId.localeCompare(b.deliveryId));
  const end = query.offset + query.limit;
  return { items: rows.slice(query.offset, end), total: rows.length, offset: query.offset, limit: query.limit, nextOffset: end < rows.length ? end : null, query };
}
