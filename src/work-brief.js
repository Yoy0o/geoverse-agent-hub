// Milestone reports share the existing focus schema and optimistic concurrency.
import { z } from "zod";
import { getDoc, listDocs, updateDoc, transaction, addEvent } from "#hub/db";
import { createFocusService, briefSchema, fingerprintSchema } from "./focus.js";

const focus = createFocusService({ getDoc, listDocs, updateDoc, transaction });
const envelope = z.object({ task: z.string().min(1).max(200), expectedFingerprint: fingerprintSchema, content: briefSchema }).strict();
const invalid = (message) => Object.assign(new Error(message), { status: 400, expose: true });

export const WORK_BRIEF_GUIDE = [
  "## 阶段成果：自动维护同一张短摘要卡",
  "遇到临时插单或主动暂停：先读取 get_work_context，再用 pause_task 保存原因、结论、恢复第一步和已有插单编号；脚本用 task.sh pause。暂停不等于 Agent 进程已停止，按返回的 execution 提示处理。恢复用 resume_task / task.sh resume 回到待执行，读取断点后另行开工；已暂停时禁止靠心跳或 start_task 自动重启。",
  "开工、恢复工作和每次写摘要前，先用 get_work_context 或 bash scripts/agent/hub.sh context 读取最新上下文及 expectedFingerprint。任务单内的指纹只是生成时快照，不能长期复用。",
  "仅在形成结论、完成阶段验证、出现阻塞或需要人决定时更新；普通读文件、心跳、无实质变化不更新。summary ≤280字，nextAction ≤200字且能直接执行；decision ≤160字、recommendation ≤200字，只在确实需要人判断时填写。risk ≤280字，evidence 提供真实 HTTP(S) 链接和已知版本，relations 只关联已确认存在的任务。未知验证写 unknown。",
  "优先调用 update_work_brief(id, expectedFingerprint, content)。没有 MCP 时，保存 {expectedFingerprint,content} 为 JSON，再运行 bash scripts/agent/hub.sh brief <JSON文件>。content 是完整替换，保留仍有效的证据、关系和未决事项。409 时重新读上下文并核对变化，禁止只换指纹强行覆盖。",
  "无法直接调用时，在回复末尾输出 agent-work-brief 代码块，内容必须是 JSON：{task,expectedFingerprint,content}，钩子和执行端会自动回传。摘要不是交付回执，不推进状态、不标记已读、不代表验收。",
  "最终交付仍输出 agent-receipt。通过 MCP 提交回执后须重新读取上下文再更新摘要；仅靠输出代码块时，Hub 先处理阶段摘要、再处理回执。给人的说明保留结论、变化和需要决定的事项，长过程放在依据中。",
  "交付回执必须注明实际 version（完整 Git 提交号或文档/实验版本），run 填当前执行编号，未知则留空。代码先提交，再 task.sh check，使验证结果对应实际提交；Hub 不会替你运行或证明测试。相同回执重放会去重，历史版本不会被覆盖。",
  "人工验收前用 get_delivery / task.sh delivery 读取当前成果编号和验收指纹（不同于阶段摘要指纹）。只有用户明确核对成果、验证依据及逐项验收标准后，才通过 move_task 或 task.sh review 提交 merge，填写 expectedDeliveryId、expectedFingerprint、verificationConfirmed、acceptedCriteria。不得从进度勾选推断验收通过，也不得自动替用户确认。409 时重新阅读，不可只换指纹重试。task.sh merge 只合并已验收且与分支提交一致的版本。",
].join("\n");

export function workContext(id) { return focus.context(id); }

export function findWorkBrief(text) {
  const raw = String(text || "");
  const block = s => [...s.matchAll(/```\s*agent-work-brief\s*\n([\s\S]*?)```/gi)].at(-1)?.[1];
  let body = block(raw);
  if (!body && /agent-work-brief/i.test(raw)) {
    const decoded = raw.replace(/\\\\/g, "\u0000").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\u0000/g, "\\");
    body = block(decoded);
  }
  if (body === undefined) return null;
  if (body.length > 40000) throw invalid("阶段摘要过长，请使用简短字段和证据链接");
  let value;
  try { value = JSON.parse(body); } catch { throw invalid("agent-work-brief 必须是有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("agent-work-brief 必须是 JSON 对象");
  return value;
}

export function receiveWorkBrief(text, taskId, origin) {
  const input = findWorkBrief(text);
  if (!input) return null;
  const parsed = envelope.safeParse(input);
  if (!parsed.success) throw invalid("阶段摘要格式不合法：" + parsed.error.issues.map(e => e.message).join("；"));
  const report = parsed.data;
  if (!taskId || report.task !== taskId) throw invalid("阶段摘要与当前绑定任务不一致，本次未写入");
  const current = focus.get(taskId);
  // Identical cross-transport replay is a no-op, never a fresh read/decision.
  if (JSON.stringify(current.content) === JSON.stringify(report.content)) return { status: "unchanged", fingerprint: current.fingerprint };
  const result = focus.update(taskId, { expectedFingerprint: report.expectedFingerprint, content: report.content }, origin);
  addEvent({ agent: origin, kind: "work_brief", task: taskId, summary: "阶段摘要已更新：" + report.content.summary.slice(0, 100) });
  return { status: "updated", fingerprint: result.fingerprint };
}
