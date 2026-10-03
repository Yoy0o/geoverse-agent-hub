// 停用（云端唯一）：本 Hub 退役为只读，写操作返回 410 并指向云端 Hub。
// 用 `node src/cli.js retire <云端地址>` 开启（先完成最后一次同步），也可以用环境变量 HUB_RETIRED_TO 固定。
// 状态存在 kv 里，每个请求按主键读一次（不缓存：CLI 开关后立即对正在运行的服务生效）。
import { kv } from "#hub/db";
import { config } from "#hub/config";

export function retiredTo() { return config.retiredTo || String(kv.get("hub:retiredTo") || ""); }
export function setRetired(url) { if (url) kv.set("hub:retiredTo", url); else kv.del("hub:retiredTo"); }
export const retiredHint = (to) => `本 Hub 已停用（只读），任务数据以云端为准：${to}。在这台电脑运行 connect.mjs --url ${to} 切换到云端。`;
