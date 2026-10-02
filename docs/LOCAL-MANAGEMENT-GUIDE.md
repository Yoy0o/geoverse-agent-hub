# 本地管理使用指南

适用于把任务数据保存在当前电脑的 Docker Hub。核对日期：2026-09-30。

## 1. 本机已经配置的内容

| 项目 | 当前配置 |
| --- | --- |
| 网页入口 | <http://127.0.0.1:8787> |
| 容器 | `agent-hub`，端口仅绑定 `127.0.0.1` |
| Codex MCP 名称 | `agent-hub-local` |
| 脚本凭据文件 | `%USERPROFILE%/.config/agent-hub/local.env` |
| 初始项目 | `geoverse-agent-hub`，本地目录 `D:/workspace/geoverse-agent-hub` |
| 本次登记任务 | `T260930-x6r`：本地管理：完成本机接入与初始项目登记 |
| 初始任务状态 | 已提交交付回执，待本人评审 |

接入后共 6 个项目、19 个任务、4 条规则、0 个复盘。本次只新增当前仓库的项目和一个任务，保留原有数据。数字是登记时的快照，不是以后必须保持的数量。

已实际完成 MCP 握手、工具列表查询、新建任务，以及 `today`、`get_project`、`get_task` 调用。用户级 Codex 配置修改前自动备份；QGIS、Cloudflare 等现有连接保留。没有开启新的 OTel 遥测，也没有自动安装项目钩子。

重新打开 Codex 会话/应用后加载新 MCP 配置。当前对话中的工具列表不会因为磁盘配置变化而自动更新。

## 2. 与云端管理的区别

| 操作 | 本地 Hub | 云端 Hub |
| --- | --- | --- |
| 任务、项目、规则存储 | 当前电脑的 Docker SQLite 数据卷 | Cloudflare SQLite Durable Object |
| 网页登录 | 本地 HUB_TOKEN | 本人 Access 邮箱验证码 + 独立云端 HUB_TOKEN |
| 本机 Agent 连接 | 本地令牌，无 Access 服务凭证 | 云端令牌 + 本机 Access Client ID/Secret |
| 电脑关闭后 | Hub 不可用 | Hub 网页仍可用；这台电脑的 Agent 不再执行 |
| 断网后 | 本地 Hub 正常；模型与 Git 远程功能取决于网络 | 无法管理云端数据 |
| 源码与命令执行 | 仍在本机仓库/worktree | 也仍在本机仓库/worktree，不由 Hub 自动执行 |
| 更新服务 | 重新构建、启动 Docker | 检查配置后发布 Worker |
| 数据切换 | 配置 `HUB_SYNC_*` 后与云端双向同步 | 作为同步对端，无需配置 |
| 执行端（runner.mjs） | 可以连本地 Hub | 推荐连云端 Hub，手机上也能派发 |

两端数据默认独立。需要保持一致时，在本地 `.env` 设置 `HUB_SYNC_URL`、`HUB_SYNC_TOKEN`（云端令牌）、`HUB_SYNC_ACCESS_CLIENT_ID/SECRET`（本机 Access 服务凭证）后 `docker compose up -d`，本地 Hub 每 60 秒与云端同步任务、规则、复盘和设置。两边都已有数据时，第一次同步会合并成并集：先备份两端，再用 `docker compose exec agent-hub node src/cli.js sync --dry-run` 预览。细节见[执行管理与多端同步](EXECUTION-AND-SYNC.md)。网页标题栏的徽标显示当前打开的是哪个 Hub。

## 3. 启动、停止与网页使用

在仓库 PowerShell 中：

```powershell
Set-Location D:/workspace/geoverse-agent-hub
docker compose up -d
docker compose ps
```

打开本地网页，用**本地**令牌登录。需要查看本地令牌时，可在自己的终端运行 `docker compose exec agent-hub node src/cli.js token`，不要把输出复制到聊天、截图或提交到 Git。云端的密钥不适用于此入口。

“今日”查看需介入/待评审事项；“看板”推进任务；“项目”维护验证命令、约束与禁区；“规则库”和“复盘”记录可复用经验。网页应显示已经连接到 Hub。若显示“本地模式”或没有连接提示，先恢复认证与服务，不要把页面内临时改动视为已经入库。

停止服务可用 `docker compose stop agent-hub`，再次使用执行 `docker compose start agent-hub`。日常停止不删除数据卷。

## 4. 在 Codex 中使用

明确指定 **agent-hub-local**，例如：

```text
用 agent-hub-local 的 today 查看今天需要处理的事项。
用 agent-hub-local 的 get_project 读取 geoverse-agent-hub 项目约束。
用 agent-hub-local 的 get_task 读取 T260930-x6r，并按允许范围执行。
```

新任务用 `create_task`，填写项目名、目标、可验证的验收标准、允许/禁止路径、风险和预算。执行开始用 `start_task`；完成用 `submit_receipt` 提交实际修改、验证结果和风险，交给人评审。`submit_receipt` 不代表已经合并 Git。

本次没有自动启动额外 Agent，也没有为登记任务创建分支或 worktree。登记项目里的路径是元数据；不会创建目录、上传源码或运行命令。

## 5. 本地脚本选择正确的配置

当前两个 MCP 名称可以共存。Bash 脚本通过 `AGENT_HUB_CONFIG` 选凭据文件；`AGENT_HUB_URL` 已设置时会优先使用它，必须先清理上一次连接的进程环境。

在 PowerShell 中使用 Git Bash：

```powershell
'AGENT_HUB_URL','AGENT_HUB_TOKEN','CF_ACCESS_CLIENT_ID','CF_ACCESS_CLIENT_SECRET' |
  ForEach-Object { Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue }
$env:AGENT_HUB_CONFIG = "$env:USERPROFILE/.config/agent-hub/local.env" -replace '\\','/'
& 'D:/Program Files/Git/bin/bash.exe' kit/scripts/hub.sh ping
```

本机 Git Bash 已核对安装于上面的 D 盘路径；其他电脑路径不同则替换。不要把 `C:/Windows/system32/bash.exe`（WSL 启动器）当作 Git Bash。这里使用仓库内现有 `kit/scripts/hub.sh`，不要求先安装接入包。切换脚本配置不会改变 Codex 的两个 MCP 名称。

重新配置本地 Codex 时，先从现有本地凭据文件加载进程变量，再运行：

```powershell
Get-Content -LiteralPath "$env:USERPROFILE/.config/agent-hub/local.env" | ForEach-Object {
  $entry = $_ -split '=',2
  if ($entry.Count -eq 2) { [Environment]::SetEnvironmentVariable($entry[0],$entry[1],'Process') }
}
node kit/connect.mjs --url http://127.0.0.1:8787 --agents codex --name agent-hub-local --profile local --no-otel
```

换电脑时先取得该本地 Hub 的令牌放入 `AGENT_HUB_TOKEN`，再运行连接命令。连接脚本从环境变量读取令牌，不必把密钥写入命令参数。`--profile local` 只更新 `local.env`，不覆盖 `cloud.env` 或默认 `env`；`--name` 避免覆盖云端 MCP。

## 6. 需要分支/worktree、项目钩子时

在当前 Hub 的“项目”页下载该项目接入包，先检查里面的验证脚本，再用 Git Bash 执行 `bash <接入包目录>/install.sh <项目目录>`。安装会增加项目脚本、配置和 Git 钩子；已有规则文件通常另存新版本等待合并，脚本更新会备份。安装后检查差异，提交脚本，让新 worktree 能取得它们。

接入包安装完成并选择本地配置后：

```bash
bash scripts/agent/hub.sh ping
bash scripts/agent/task.sh new "实现一个明确的需求" --risk L2 --allow 'src/**' --budget 60
bash scripts/agent/task.sh start <返回的任务编号> feature --agent codex
bash scripts/agent/task.sh check <任务编号>
```

`start` 创建本地 Git 分支和独立 worktree，并在所选 Hub 生成一条“本机 · 执行中”的执行记录；之后钩子上报就是心跳，网页“执行”页能看到进度和当前步骤。代码执行与验证仍在本机。评审通过后再由本人执行 `task.sh merge`，它会改变 Git 主分支并上报合并结果。

希望从网页或手机把任务交给这台电脑时，常驻一个执行端（默认只准备工作区，加 `--exec` 才会无人值守启动 Agent）：

```bash
node kit/runner.mjs register --profile local --name "DIY-Liu 工作站" --project geoverse-agent-hub=D:/workspace/geoverse-agent-hub --agents codex
node kit/runner.mjs start --profile local
```

## 7. 备份与更新

在本地网页“导出与设置”下载业务 JSON，保存到自己的备份目录或被忽略的 `migrate/`。JSON 含任务、项目配置、规则、复盘，不含完整事件、Agent 会话和网页登录状态。

CLI 操作必须进入实际容器。直接在宿主机运行 `node src/cli.js export` 可能读到另一份数据库，不代表 Docker 数据卷：

```powershell
docker compose exec agent-hub node src/cli.js stats
# 备份容器内数据库文件/整个数据卷时，按停机或一致性备份流程操作。
# 不要直接复制正在写入的 SQLite 主文件而遗漏 WAL。
```

更新前备份，随后执行 `docker compose up -d --build agent-hub`。本机当前容器仍是已有构建；本次只改接入配置与登记数据，没有重新构建它。

不要用 `docker compose down -v` 排查一般连接问题，它会删除数据卷。需要与云端保持一致时用多端同步（见第 2 节），不必再手动搬运 JSON；同步前仍建议两端各导出一份 JSON 备份。

## 8. 常见问题

| 现象 | 排查 |
| --- | --- |
| 连接拒绝 | 检查 Docker Desktop、`docker compose ps`、8787 端口 |
| HTTP 401 | 本地令牌不正确或已轮换；不要使用云端令牌 |
| 项目/任务出现在错误工作台 | 检查 MCP 名称、`AGENT_HUB_CONFIG` 和优先级更高的进程 URL |
| Codex 看不到工具 | 重新打开会话/应用，确认 `agent-hub-local` 已启用 |
| 网页有任务，宿主机 CLI 没有 | 两者读取的 SQLite 路径不同；使用容器内 CLI |
| 钩子无活动 | 本次未安装项目接入包；安装后检查 profile 和脚本 ping |

Codex MCP 用户配置与 HTTP 认证方式参考 [OpenAI Docs](https://developers.openai.com/codex/mcp)。
