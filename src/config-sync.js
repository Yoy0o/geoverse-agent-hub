// 多端同步配置（Node 与 Cloudflare 共用，不依赖文件系统）
const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));

export function syncConfig(e) {
  const url = String(e.HUB_SYNC_URL || "").trim().replace(/\/+$/, "");
  return {
    url, token: String(e.HUB_SYNC_TOKEN || "").trim(),
    accessId: String(e.HUB_SYNC_ACCESS_CLIENT_ID || "").trim(), accessSecret: String(e.HUB_SYNC_ACCESS_CLIENT_SECRET || "").trim(),
    // 自动同步间隔（秒），0 = 只手动同步
    interval: Math.max(0, num(e.HUB_SYNC_INTERVAL, 60)),
    // both 双向；pull 只从对端拉取（本端当镜像）；push 只推送到对端
    mode: ["both", "pull", "push"].includes(e.HUB_SYNC_MODE) ? e.HUB_SYNC_MODE : "both",
  };
}
