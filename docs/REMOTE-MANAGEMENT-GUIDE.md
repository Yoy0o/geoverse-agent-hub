# 远程管理使用指南

适用于 Cloudflare 上的个人 Hub。这里的“远程”指任务数据与管理网页在云端；当前电脑上的 Agent、源码和命令仍在本机运行。核对日期：2026-09-30。

> **2026-10-03 起这是唯一的 Hub（云端唯一）。** 迁移完成后，这台电脑的默认连接（`~/.config/agent-hub/env`）就是云端，脚本不再需要设置 `AGENT_HUB_CONFIG`，MCP 只保留 `agent-hub-cloud`。迁移步骤、断网暂存补发和备份见 [云端唯一：迁移与日常](CLOUD-ONLY.md)；下文第 5 节的 profile 切换只在迁移前需要。

## 1. 当前入口与本机登记

| 项目 | 当前配置 |
| --- | --- |
| 网页 | <https://geoverse-agent-hub.libra-liuyb.workers.dev> |
| 浏览器身份 | `hio250@163.com`，Access 邮箱 OTP |
| Codex MCP 名称 | `agent-hub-cloud` |
| 脚本凭据文件 | `%USERPROFILE%/.config/agent-hub/cloud.env` |
| 初始项目 | `geoverse-agent-hub`，对应本机目录 `D:/workspace/geoverse-agent-hub` |
| 本次登记任务 | `T260930-2eo`：云端管理：完成本机接入与初始项目登记 |
| 初始任务状态 | 已提交交付回执，待本人评审 |
| 当前登记数量 | 1 个项目、1 个任务、0 条规则、0 个复盘 |
| 本机 Access 服务凭证 | `GeoVerse DIY-Liu workstation`，仅用于本机接入 |
| 凭证到期 | **2026-10-30 16:00:53（Asia/Shanghai）** |

用户最初选择保持空工作台；本次根据新的接入与登记请求，只新增当前仓库的项目和任务，未导入本地已有数据。登记数量是当前快照。

已实际从本机完成 HTTPS 认证、MCP 握手、工具查询、任务创建，以及 `today`、`get_project`、`get_task` 调用。没有自动安装项目钩子或开启新的 OTel 遥测。重新打开 Codex 会话/应用后才能加载新 MCP 配置。

## 2. 三种认证不要混用

| 使用者/用途 | 需要的认证 | 权限作用 |
| --- | --- | --- |
| 本人浏览器 | Access 邮箱验证码 + 云端 HUB_TOKEN 登录 | 打开网页并管理任务 |
| 这台电脑的 Codex/脚本 | 云端 HUB_TOKEN + Access Client ID/Secret | 调用云端 MCP/API |
| 发布与修改账户资源 | Wrangler/Cloudflare MCP 管理 OAuth | 发布 Worker、管理 Access；不是 Hub 的业务登录 |

Access 的本机策略是 **Service Auth**，只包括一个明确的服务凭证；Worker 还校验签名、AUD 和该 Client ID。邮箱策略继续仅允许本人，预览 URL 关闭，没有 Everyone 或 Bypass。服务凭证配合 Hub 令牌具有工作台读写能力；目前不支持只读或逐任务授权。

Client ID 是标识符，Client Secret、HUB_TOKEN 是密钥。不要把 Client Secret 放入 `wrangler.jsonc`、命令参数、文档或 Git。服务凭证只允许访问这个 Hub，不授予 Cloudflare 账户管理权限。[Cloudflare 服务凭证文档](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

## 3. 浏览器日常管理

1. 打开云端入口，用 `hio250@163.com` 收取验证码。Access 会话当前为 24 小时。
2. 用独立云端 HUB_TOKEN 登录 Hub。云端令牌与本地 Docker 令牌不同；Hub 会话当前为 7 天，Access 过期时仍需重新认证。
3. 在“今日”处理需介入/待评审事项，在“看板”查看任务状态，在“项目”维护约束和验证命令，在“规则库/复盘”记录经验。
4. 完成管理后可退出 Hub。Hub 退出会撤销 Hub 会话并关闭其实时连接；Access 的浏览器会话是另一层认证。

本机关闭后云端网页仍可使用。Hub 不会替关机的电脑运行 Codex、Git、构建或测试。项目目录仅为记录，不是云端挂载的文件系统。

## 4. 本机 Codex 使用方式

明确使用 **agent-hub-cloud**，例如：

```text
用 agent-hub-cloud 的 today 查看云端待办。
用 agent-hub-cloud 的 get_project 读取 geoverse-agent-hub 的验证命令和约束。
用 agent-hub-cloud 的 get_task 读取 T260930-2eo。
```

新任务用 `create_task` 登记，开始用 `start_task`，完成用 `submit_receipt` 上报实际验证结果，再由本人评审。MCP 的状态记录不会自动创建 Git 分支、修改文件或合并代码；需要本地 worktree 时使用项目接入包的 `task.sh`。

推荐把云端 Hub 作为多设备的控制面：执行端（`runner.mjs --profile cloud`）连云端，手机上就能派发任务、看执行进度、评审；本地 Hub 可选，在本地 `.env` 配置 `HUB_SYNC_*` 后与云端双向同步，断网时继续用。没有配置同步时两端数据各自独立，不要在两边分别新建同一项工作。见[执行管理与多端同步](EXECUTION-AND-SYNC.md)。

把任务交给不在身边的电脑：

```powershell
node kit/runner.mjs register --profile cloud --name "DIY-Liu 工作站" --project geoverse-agent-hub=D:/workspace/geoverse-agent-hub --agents codex
node kit/runner.mjs start --profile cloud
```

之后在云端网页任务详情点“派发执行”。交给 Claude Code 网页版等云端 Agent 时选“交给云端 Agent”，把提示词发过去，Agent 运行 `task.sh attach <任务编号>` 后这里显示“云端 · 执行中”。

## 5. 脚本切换到云端

PowerShell + Git Bash 示例：

```powershell
'AGENT_HUB_URL','AGENT_HUB_TOKEN','CF_ACCESS_CLIENT_ID','CF_ACCESS_CLIENT_SECRET' |
  ForEach-Object { Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue }
$env:AGENT_HUB_CONFIG = "$env:USERPROFILE/.config/agent-hub/cloud.env" -replace '\\','/'
& 'D:/Program Files/Git/bin/bash.exe' kit/scripts/hub.sh ping
```

本机 Git Bash 已核对安装于上面的 D 盘路径，其他电脑按实际安装位置替换，避免误用 WSL 启动器。`AGENT_HUB_URL` 进程变量优先于配置文件，所以上面先清理旧的连接变量。脚本地址切换不改变 `agent-hub-local` 或 `agent-hub-cloud` MCP 定义。

重新注册本机云端 Codex 时：

```powershell
Get-Content -LiteralPath "$env:USERPROFILE/.config/agent-hub/cloud.env" | ForEach-Object {
  $entry = $_ -split '=',2
  if ($entry.Count -eq 2) { [Environment]::SetEnvironmentVariable($entry[0],$entry[1],'Process') }
}
node kit/connect.mjs --url https://geoverse-agent-hub.libra-liuyb.workers.dev --agents codex --name agent-hub-cloud --profile cloud --no-otel
```

命令从进程环境读取云端令牌和 Access 凭证。`--profile cloud` 保存到 `cloud.env`，`--name agent-hub-cloud` 保留本地 MCP；配置修改前会自动备份。`--no-otel` 不新增遥测配置，任务工具的调用记录仍属于正常业务活动。

在云端“项目”页下载接入包，检查后用 Git Bash 安装到目标仓库。随后可用 `scripts/agent/task.sh new/start/check` 管理本地分支/worktree，并向云端同步任务状态。安装会修改项目脚本/钩子，当前尚未自动安装；详见[本地指南的接入包步骤](LOCAL-MANAGEMENT-GUIDE.md#6-需要分支worktree项目钩子时)。

## 6. 新电脑、过期与撤销

每台电脑创建独立的 Access 服务凭证，用明确的机器名命名并设置到期时间。为本应用增加只包括该凭证的 Service Auth 策略，再把该 Client ID 加入 Worker `ACCESS_SERVICE_IDS` 并重新发布。不要复制这一台电脑的 Client Secret 给其他机器。

将新机器的 HUB_TOKEN、Client ID、Client Secret 放到其本地安全环境中，再运行上述连接命令。浏览器 OTP 无需也不应长期导出给无人值守脚本使用。

这台电脑的凭证在 2026-10-30 到期。到期前在 Cloudflare One → Access controls → Service credentials 检查、续期或轮换；更新本机 `cloud.env` 和 Codex 认证头，重新运行连接脚本并重新打开 Codex。若只是续期且 ID/Secret 未变，仍应核对实际请求。若更换凭证，则同步策略和 Worker 白名单。

丢失电脑或不再需要接入时，先禁用/吊销对应服务凭证，再移除本应用策略和 Worker 白名单项，并删除该电脑的配置。不要删除 Worker 或改变 `HUB_INSTANCE` 来撤销机器。

主 Hub 令牌泄露时通过 `npx wrangler secret put HUB_TOKEN` 轮换，更新可信设备的本地凭据和 MCP 认证头；旧 Hub 会话会失效。服务凭证与 Hub 令牌分别维护。

本机 `%USERPROFILE%/.config/agent-hub/cloud.env`、`%USERPROFILE%/.codex/config.toml` 和其备份包含认证信息。部署密钥副本在被忽略的 `.cloudflare/bootstrap-secrets.json`，本机服务凭证副本在被忽略的 `.cloudflare/machine-access.json`。请本人存入密码管理器，确认配置及备份足够后再处理副本；Windows 文件权限应以 NTFS 为准。

## 7. 云端备份、发布与本地 CLI 边界

网页“导出与设置”导出业务 JSON，保存到私有备份位置。JSON 不含完整事件、Agent 会话或网页登录状态；完整数据库恢复需核对 SQLite DO 的 PITR 能力。代码回滚不等于数据回滚。

需要从已有本地 Hub 迁移时，先导出本地 JSON，再在云端恢复并核对项目/任务/规则/复盘。恢复是导入覆盖同 ID 文档；需要持续保持一致时改用多端同步（两端都改过的文档按规则合并并记录冲突）。无论哪种方式都先备份两端。

`node src/cli.js token/export/import/stats` 操作执行环境的本地数据库，**不会因为设置云端 URL 就操作 Durable Object**。云端业务管理使用网页、MCP 或经认证的 HTTP API；不要用宿主机 CLI 导入云端数据。

发布服务时在源码仓库执行：

```powershell
npx wrangler whoami
npm run preflight:cloudflare
npm run build:cloudflare
npm run deploy:cloudflare
```

已有 Worker 继承云端 Secret 和 DO 数据。不要再运行首次 bootstrap，也不要改 `HUB_INSTANCE=personal` 或删除迁移历史。GitHub 推送只运行 CI，不自动发布 Cloudflare。Workers Free 的 CPU/请求/DO 用量仍需观察，SSE 长连接会消耗 DO 活动时长。

## 8. 故障判断

| 现象 | 常见原因与处理 |
| --- | --- |
| 302 到 Access 登录 | 脚本没带服务凭证；浏览器登录不能代替脚本认证 |
| 403 | Access 服务凭证/策略不匹配，或 Worker Client ID 白名单不匹配 |
| 401 | 已通过 Access 但 Hub 令牌错误，或 Access JWT 校验失败；根据响应来源排查 |
| 浏览器正常、Codex 失败 | 核对 `cloud.env`、Codex HTTP 认证头和服务凭证到期时间 |
| 更新配置后仍失败 | 重开 Codex 会话，确认使用 agent-hub-cloud；复核远程 Worker 配置已发布 |
| 任务出现在本地 | 选错 MCP 或进程 URL；两个数据库不会自动转移任务 |
| Bash 报 TLS 连接超时 | 已将连接超时从 1 秒改为默认 5 秒；慢网络可设置 `AGENT_HUB_CONNECT_TIMEOUT=10`，API 请求总时限仍为 20 秒 |
| 免费额度相关错误 | 查看 Workers Metrics/Logs 和 DO 用量，按实际需求评估套餐 |

详细基础设施配置见[云端准备指南](CLOUDFLARE-CLOUD-PREPARATION.md)，本地操作见[本地管理指南](LOCAL-MANAGEMENT-GUIDE.md)。Codex 配置参考 [OpenAI Docs](https://developers.openai.com/codex/mcp)。访问控制限制访问者，Cloudflare 仍托管和处理云端数据。
