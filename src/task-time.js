// Workflow time, not CPU time: only confirmed intervals in 执行中 count.
// Old tasks start a partial clock on their first write; never invent past work.
export function activeMs(task, now = Date.now()) {
  const c = task.workClock;
  if (!c) return null;
  const start = Date.parse(c.runningSince || "");
  return Math.max(0, Number(c.activeMs) || 0) + (task.status === "执行中" && Number.isFinite(start) ? Math.max(0, now - start) : 0);
}
export function nextClock(before, status, at) {
  const c = before?.workClock;
  if (!c) return { activeMs: 0, runningSince: status === "执行中" ? at : null, trackedSince: at, partial: !!before };
  if (before.status === status) return c;
  return { ...c, activeMs: activeMs(before, Date.parse(at)), runningSince: status === "执行中" ? at : null };
}
