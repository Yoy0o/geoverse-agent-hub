# 云端唯一：迁移与日常

适用于 agent-hub 0.3.0。核对日期：2026-10-03。

## 1. 目标状态

| 角色 | 云端唯一之后 |
| --- | --- |
| 云端 Hub `https://geoverse-agent-hub.libra-liuyb.workers.dev` | **唯一的数据来源**：网页、手机、所有 Agent 的 MCP、钩子、OTel、执行端、云端 Agent 都连它 |
| 本地 Docker Hub | 退役为只读：写入返回 410 并指向云端；可以停掉，也可以留作只读镜像 |
| 这台电脑的脚本 | 默认连接（`~/.config/agent-hub/env`）就是云端，不再需要 `AGENT_HUB_CONFIG` 切换 |
| Agent 的 MCP | 只保留 `agent-hub-cloud`；`agent-hub-local` 删除 |
| 网络中断 | 事件、回执、进度先暂存在本机 `~/.cache/agent-hub/spool`，恢复后按原始时间补发 |

为什么这样做：Agent 本身要联网调用模型，“断网时改用本地 Hub”几乎用不上；两套 Hub 却意味着两个令牌、两组 MCP 名称、两个 profile，以及“记录到底在哪边”的持续困惑。网络不稳的问题由本地暂存补发来解决，不再靠第二个 Hub。

## 2. 前提

1. 云端已发布 0.3.0：在仓库里 `npm run preflight:cloudflare && npm run deploy:cloudflare`。新表和索引在 Durable Object 启动时自动迁移，已有数据不变。
2. 本机的 Access 服务凭证有效。当前凭证 **2026-10-30 到期**，到期后脚本、MCP、执行端会一起断开，见[远程管理指南第 6 节](REMOTE-MANAGEMENT-GUIDE.md#6-新电脑过期与撤销)。

## 3. 迁移步骤

### 3.1 备份两端

```powershell
Set-Location D:/workspace/geoverse-agent-hub
docker compose exec agent-hub node src/cli.js export /data/before-cloud-only.json
docker compose cp agent-hub:/data/before-cloud-only.json ./migrate/local-before-cloud-only.json
```

云端在网页“同步与设置 → 下载 JSON 备份”，保存到同一个 `migrate/`（已被 Git 忽略）。

### 3.2 把本地数据并入云端

在本地 `.env` 增加（令牌和 Secret 不要写进命令行或提交到 Git）：

```bash
HUB_SYNC_URL=https://geoverse-agent-hub.libra-liuyb.workers.dev
HUB_SYNC_TOKEN=<云端 HUB_TOKEN>
HUB_SYNC_ACCESS_CLIENT_ID=<本机 Access 服务凭证 Client ID>
HUB_SYNC_ACCESS_CLIENT_SECRET=<本机 Access 服务凭证 Client Secret>
HUB_SYNC_INTERVAL=0
HUB_SYNC_MODE=both
```

```powershell
docker compose up -d --build agent-hub
docker compose exec agent-hub node src/cli.js sync --dry-run
```

预览会列出要推到云端和要拉回本地的文档数，以及两边都有的文档（至少会有 `config/main`：项目和 Agent 列表取并集，同名项目以后修改的一方为准）。确认无误后进入下一步；不需要单独运行正式同步。

两边各有一个“完成本机接入与初始项目登记”的任务（`T260930-x6r`、`T260930-2eo`），编号不同，合并后都会保留；不需要的那个在云端网页放弃即可。

### 3.3 停用本地 Hub

```powershell
docker compose exec agent-hub node src/cli.js retire https://geoverse-agent-hub.libra-liuyb.workers.dev
```

`retire` 会先与云端做最后一次同步，确认本地修改全部推送（没有待推送、没有被云端拒收待重试）之后才停用；任何一步失败都不会停用。停用后：

- 本地网页显示“本 Hub 已停用（只读）”，写入提示到云端操作
- 写接口返回 410 和云端地址；钩子的会话开始事件会把“请切换到云端”提示交给 Agent
- MCP 只保留只读工具（today、list_tasks、get_task……），写工具返回切换提示
- 读取照常可用；撤销用 `node src/cli.js retire --undo`

### 3.4 切换这台电脑

在 PowerShell 中先把云端凭据载入当前进程（不出现在命令行里），再重新连接：

```powershell
'AGENT_HUB_URL','AGENT_HUB_TOKEN','CF_ACCESS_CLIENT_ID','CF_ACCESS_CLIENT_SECRET','AGENT_HUB_CONFIG' |
  ForEach-Object { Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue }
Get-Content -LiteralPath "$env:USERPROFILE/.config/agent-hub/cloud.env" | ForEach-Object {
  $entry = $_ -split '=',2
  if ($entry.Count -eq 2) { [Environment]::SetEnvironmentVariable($entry[0],$entry[1],'Process') }
}
# 不加 --profile：写入默认 env，仓库脚本默认连云端
node kit/connect.mjs --url https://geoverse-agent-hub.libra-liuyb.workers.dev --agents codex --name agent-hub-cloud --no-otel
# 删除各 Agent 里指向本地 Hub 的 MCP，以及 local.env（改前自动备份）
node kit/connect.mjs --remove agent-hub-local --profile local
& 'D:/Program Files/Git/bin/bash.exe' kit/scripts/hub.sh ping
```

`hub.sh ping` 显示“已连接 https://geoverse-agent-hub…”即完成。重新打开 Codex 会话后，只会看到 `agent-hub-cloud`。其他电脑重复本节（每台电脑使用自己的 Access 服务凭证）。

### 3.5 执行端（需要从网页 / 手机派发时）

```powershell
node kit/runner.mjs register --name "DIY-Liu 工作站" --project geoverse-agent-hub=D:/workspace/geoverse-agent-hub --agents codex
node kit/runner.mjs status
node kit/runner.mjs start
```

Windows 上执行端会通过 `where git` 找到 `D:/Program Files/Git/bin/bash.exe` 运行仓库脚本，不会用到 System32 的 WSL 启动器；找不到时用 `--bash "D:/Program Files/Git/bin/bash.exe"` 指定。npm 安装的 `codex.cmd` 会被解析成用 node 直接运行它的脚本，提示词不经过 cmd.exe 转义。默认只准备工作区；先这样用一段时间，再考虑对 L1 任务用 `--exec` 开启自动执行。

### 3.6 本地容器的去留

| 选择 | 做法 |
| --- | --- |
| 停掉（推荐） | `docker compose stop agent-hub`；数据卷保留，需要查旧数据时 `docker compose start agent-hub`（只读） |
| 留作只读镜像 | `.env` 改成 `HUB_SYNC_MODE=pull`、`HUB_SYNC_INTERVAL=600` 后重启：每 10 分钟从云端拉取一次，断网时可以在本地网页查阅（只读） |

## 4. 日常

- **入口只有一个**：网页、手机、MCP、脚本都指向云端。网页标题栏的徽标应显示“云端 Hub”。
- **网络抖动**：钩子、git 提交、进度上报失败时自动暂存，下一次上报成功后在后台按顺序补发，事件按原始时间记录，不会把已停滞的执行误判为活着。`bash scripts/agent/hub.sh ping` 会显示积压数量，`hub.sh flush` 立即补发。会话开始的任务单注入无法补发，但 `specs/<编号>.md` 里一直有任务单。
- **备份**：SQLite Durable Object 支持时间点恢复（需按 Cloudflare 文档操作）；业务数据每周再导出一份 JSON，例如用 Windows 计划任务运行
  `"D:/Program Files/Git/bin/bash.exe" D:/workspace/geoverse-agent-hub/kit/scripts/hub.sh backup D:/backups/agent-hub`。
- **免费额度**：0.3.0 起“接入”页的状态查询只扫描最近 24 小时的事件，且只在打开“接入”页时刷新；执行端心跳默认 30 秒。单台执行端加日常使用远低于 Workers 免费档的请求与读写额度；多台执行端长期常驻时留意 Cloudflare 后台的 Durable Objects 用量。

## 5. 回退

```powershell
docker compose exec agent-hub node src/cli.js retire --undo
node kit/connect.mjs --url http://127.0.0.1:8787 --agents codex --name agent-hub-local --profile local --no-otel
```

本地 Hub 恢复可写后，云端在停用期间产生的数据要靠同步（`HUB_SYNC_MODE=both`）拉回本地。
