# 执行管理与多端同步

适用于 agent-hub 0.3.0。核对日期：2026-10-03。部署形态已确定为**云端唯一**，迁移步骤见 [云端唯一：迁移与日常](CLOUD-ONLY.md)。

这份文档说明平台怎样管理“任务在哪里执行、做到哪一步、是否还活着”，以及本地 Hub 和云端 Hub 怎样保持一致。日常操作见[本地管理指南](LOCAL-MANAGEMENT-GUIDE.md)与[远程管理指南](REMOTE-MANAGEMENT-GUIDE.md)。

## 1. 要解决的问题

0.1.0 里有三个缺口：

1. **只有任务状态，没有执行情况。** Hub 知道任务处于“执行中”，但不知道它在哪台电脑、哪个云端会话里跑，也不知道 Agent 是否已经卡住、会话是否早已结束。
2. **人不在电脑前就交不出任务。** 手机上能建任务、评审，却没办法让家里或公司的电脑开工。
3. **本地 Hub 和云端 Hub 各管各的。** 同一个任务的进度只在一边看得到，两边的数据只能靠导出、导入 JSON 搬运。

0.2.0 用三样东西补上：**执行记录**（每次执行尝试）、**执行端**（会领取派发的电脑或云端机器）和**多端同步**（Hub 之间增量双向同步）。

## 2. 概念

| 概念 | 回答的问题 | 存放位置 |
| --- | --- | --- |
| 任务 | 做什么、验收标准、评审结论 | 文档库，随多端同步 |
| 执行记录（run） | 这一次在哪里执行：本机 / 云端、主机或执行端、哪个 Agent、哪种方式、状态、进度、当前步骤、最近心跳 | `runs` 表，留在产生它的 Hub |
| 执行摘要（`task.exec`） | 任务当前那次执行的摘要 | 任务文档里，随多端同步 |
| 执行端（runner） | 一台登记过的电脑、云端 VM 或 CI 机器，常驻 `runner.mjs` 领取派发 | `runners` 表，留在它连接的 Hub |

同一个任务同一时间只有一个进行中的执行。新的执行开始时，旧的标记为“已替代”；执行端会停止它自己启动的 Agent 进程。退回修改后重新开工，会生成第 2、3 次尝试，任务详情里能看到完整的执行历史。

### 2.1 执行状态

```
派发 ──► 排队中 ──► 已领取 ──► 待启动 ──► 执行中 ──► 已交付（回执 done）
          │ 执行端领取   │ 建好工作区   │ Agent 开始     ├─► 阻塞（回执 blocked）
          │              │              │                ├─► 失败（Agent 退出但没有回执、启动失败）
          └──────────────┴──────────────┴──────────────► ├─► 已取消（网页 / MCP 取消，任务放弃）
                                                         └─► 已替代（同一任务开始了新的执行）
手动开工（task.sh start / attach、MCP start_task、钩子会话开始）直接进入“执行中”。
```

存储的状态之外，界面和 MCP 还按心跳实时计算**健康度**：

| 健康度 | 条件 | 处理 |
| --- | --- | --- |
| 停滞 | 超过 `RUN_STALL_MINUTES`（默认 15 分钟）没有任何心跳 | 进入“今日 · 需要我处理”；去那台机器看看，或重新派发 |
| 失联 | 自动执行的执行端超过 `RUNNER_OFFLINE_SECONDS`（默认 90 秒）没有心跳 | Agent 进程已失去联系；确认机器情况后重新派发 |
| 等待执行端 | 指定的执行端当前离线 | 执行端上线后才会领取 |

### 2.2 心跳从哪里来

不需要 Agent 额外做任何事，已有的上报都会成为心跳并更新“当前步骤”：

- Agent 钩子：会话开始 / 结束、修改代码、运行工具、一轮结束、守卫拦截……
- MCP 调用：`get_task`、`log_note`、`submit_receipt` 等
- git 钩子的提交上报、`task.sh check` 的检查结果、结束前验证
- 执行端心跳：自动执行时，Agent 进程活着执行端就每 30 秒报一次
- 主动汇报进度：`hub.sh progress`、`task.sh progress`、MCP `report_progress`

网络中断时，这些上报先暂存在本机 `~/.cache/agent-hub/spool`，下一次上报成功后在后台按顺序补发，并带上原始时间：事件按发生时间入库，补发的旧事件不会把已经停滞的执行“续命”。

hub.sh 每次上报都带上执行编号（`.agent/run` 或 `AGENT_HUB_RUN`）、执行端编号、执行位置和主机名。执行位置自动识别：设置了 `CLAUDE_CODE_REMOTE`（Claude Code 云端会话）、`CODESPACES`、`GITHUB_ACTIONS`、`GITPOD_WORKSPACE_ID` 时记为“云端”，其余为“本机”；也可以用 `AGENT_HUB_LOCATION=local|cloud` 明确指定。

进度没有主动汇报时，Hub 按里程碑自动推进（只升不降）：领取 5%、工作区就绪 10%、会话开始 15%、首次修改 30%、提交 50%、检查未通过 60% / 通过 80%、交付回执 100%。主动汇报的数值优先。

## 3. 部署形态：云端唯一

```
            手机 / 浏览器
                 │
                 ▼
     ┌──────────── 云端 Hub（唯一数据来源）────────────┐
     │ 任务 · 评审 · 派发 · 执行总览 · 执行端在线 · 规则 │        ┌──── 本地 Hub ─────┐
     └──────▲──────────────▲──────────────▲───────────┘ ─ ─ ─ ─ │ 已停用（只读）     │
            │              │              │      可选：只读镜像   │ 或直接停掉         │
   runner 心跳 / 领取   钩子 / MCP / OTel   钩子 / MCP            └───────────────────┘
            │              │              │
  ┌─── 工作站 ───────┐  ┌─ 工作站上的 Agent ─┐  ┌─── 云端会话 ───────────────────────┐
  │ runner.mjs       │  │ Claude Code / Codex │  │ Claude Code 网页版 / Codex 云端 /   │
  │ → task.sh start  │  │ Cursor / Kiro …     │  │ Copilot 云端 Agent                  │
  │ → worktree       │  │ 断网时上报暂存补发   │  │ → task.sh attach <任务编号>         │
  └──────────────────┘  └────────────────────┘  └────────────────────────────────────┘
```

所有入口都连云端 Hub：网页、手机、每台电脑的 MCP / 钩子 / 执行端、云端 Agent。本地 Docker Hub 用 `node src/cli.js retire <云端地址>` 退役为只读（写入返回 410 并指向云端），可以停掉，也可以留作只读镜像。

为什么不再用两套 Hub：Agent 本身要联网调用模型，“断网时改用本地 Hub”几乎用不上；两套 Hub 意味着两个令牌、两组 MCP 名称、两个 profile，以及“记录在哪边”的持续困惑。网络抖动由本地暂存补发解决（第 2.2 节）。执行端连在哪个 Hub，就在哪个 Hub 派发和取消——云端唯一之后，这条规则自然只有一个答案。

## 4. 三种执行方式

### 4.1 本机手动开工

和 0.1.0 一样，执行记录自动生成，不用改习惯：

```bash
bash scripts/agent/task.sh start <任务编号> <简述>      # 建分支 + worktree，hub 记一条“本机 · 执行中”
bash scripts/agent/task.sh run <任务编号> claude         # 或者自己在 worktree 里打开 Agent
bash scripts/agent/task.sh progress <任务编号> 40 "实现导出接口"   # 可选：主动汇报
bash scripts/agent/task.sh status <任务编号>             # 看在哪里执行、做到哪一步
```

退回后需要在同一个分支上继续时，`task.sh start <编号> --reuse` 复用已有的分支和 worktree。

### 4.2 派发给执行端

执行端是一台常驻 `runner.mjs` 的电脑或云端机器。每台机器登记一次：

```bash
# 先用 connect.mjs 保存连接配置（云端 Hub 加 --profile cloud 和 Access 服务凭证）
node runner.mjs register --name "DIY-Liu 工作站" \
  --project geoverse-agent-hub=D:/workspace/geoverse-agent-hub \
  --project geoverse-web=D:/workspace/geoverse-web \
  --agents claude-code,codex [--exec] [--max 2] [--profile cloud]
node runner.mjs start [--profile cloud]        # 常驻：tmux、开机自启或 Windows 计划任务
node runner.mjs status                         # 本机配置与 hub 上的在线状态
```

Claude Code 的 print 模式没人能批准权限请求，所以默认模板除了自动接受编辑，只额外放行接入包脚本（统一验证、进度汇报、task.sh check）和 `git status / diff / log / add / commit`；其余命令仍会被拒绝，需要时在 `runner.json` 里自己加。Codex 的 `--full-auto` 沙箱默认不联网，需要装依赖的项目先在工作区里装好。

Windows 上执行端用 Git Bash 运行仓库脚本（通过 `where git` 和常见安装位置查找，绝不使用 System32 的 WSL 启动器，也可以 `register --bash <路径>` 指定）；npm 安装的 `.cmd` 命令会被解析成用 node 直接运行它指向的脚本，提示词不经过 cmd.exe 转义。

`runner.mjs` 可以从 Hub 下载（`<hub>/runner.mjs`，云端 Hub 受 Access 保护时需要带服务凭证），也可以直接用仓库里的 `kit/runner.mjs`。项目路径和 Agent 启动命令只保存在本机 `~/.config/agent-hub/runner[-<profile>].json`，Hub 只知道项目名和 Agent 名。

在任务详情点“派发执行”，或让任何连接了 agent-hub 的 Agent 调用 `dispatch_task`：

| 方式 | 执行端做什么 | 适合 |
| --- | --- | --- |
| 准备工作区（默认） | 领取 → `task.sh start --reuse` 建分支和 worktree、写入任务单 → 回报“待启动” | 回到电脑前直接打开 Agent 开始；人始终在环 |
| 自动执行 | 准备工作区后无人值守启动 Agent（默认 `claude -p … --permission-mode acceptEdits --allowedTools "Bash(bash scripts/agent/*)" "Bash(git status*)" …`、`codex exec --full-auto …`），输出写入 `.agent/run-<执行编号>.log`；进程退出后从输出里兜底提取回执 | 风险低、验收标准清楚的任务；执行端必须用 `--exec` 登记 |

执行端每 30 秒心跳一次（`--interval` 可调；Hub 超过 90 秒没收到心跳算离线）：报告自己还在跑的执行，拿回需要停止的执行和可以领取的数量。领取在 Hub 内原子完成，两台执行端不会领到同一条派发。不指定执行端时，派发给任一登记了该项目（且有该 Agent）的执行端。

自动执行时，结束前验证、受保护路径守卫、git 钩子照常生效；回执优先由 Stop 钩子送达，执行端的兜底提取按指纹去重。Agent 退出却没有回执时，执行记为“失败”，任务进入“需介入”。

在网页或 MCP 取消一次自动执行：执行端下一次心跳时停止进程组（Windows 用 `taskkill /T`），记为“已取消”。任务合并或放弃时，进行中的执行自动收尾。

### 4.3 交给云端 Agent

适合 Claude Code 网页版、Codex 云端、Copilot 云端 Agent 这类自己有容器的 Agent：

1. 云端环境里配置 `AGENT_HUB_URL`、`AGENT_HUB_TOKEN`（云端 Hub 再加 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`）为环境变量或密钥，并在网络策略里允许访问 Hub 的域名。仓库里需要已经提交了接入包。
2. 任务详情 → 派发执行 → 交给云端 Agent，复制生成的提示词发给云端 Agent。派发记为“排队中 · 等待 Agent 接手”，执行端不会领取它。
3. 云端 Agent 运行 `bash scripts/agent/task.sh attach <任务编号>`：不建 worktree，把当前目录绑定到任务（写入 `.agent/task`、`.agent/run` 和任务单），接手这条派发并记为“云端 · 执行中”。此后钩子上报都按 `.agent/task` 关联到任务。
4. 仓库里没有脚本时，Agent 调用 MCP `start_task(id, location="cloud")` 登记开工，过程中用 `report_progress` 汇报，结束时 `submit_receipt`。

## 5. 多端同步

云端唯一之后，同步只在两个场合用到：**迁移**（把本地 Hub 的数据并入云端，`retire` 会自动做最后一次同步）和**可选的只读镜像**（停用后的本地 Hub 以 `pull` 模式定期从云端拉取，断网时能查阅）。下面是机制说明。

### 5.1 同步什么

| 同步 | 不同步（留在各自的 Hub） |
| --- | --- |
| 任务（含执行摘要 `exec`、回执、评审、状态历史、用量汇总） | 执行记录明细、执行端 |
| 规则、复盘 | Agent 事件流、会话明细、OTel 原始数据 |
| 设置（项目档案、Agent 列表） | 网页登录会话、OAuth 客户端、令牌 |

### 5.2 配置

只有**发起同步的一端**需要配置，通常是本地 Docker Hub（它能访问云端，云端访问不到你的电脑）。在本地 `.env` 里：

```bash
HUB_NAME=本地 Hub
HUB_SYNC_URL=https://geoverse-agent-hub.<账户子域>.workers.dev
HUB_SYNC_TOKEN=<云端 Hub 的 HUB_TOKEN>
HUB_SYNC_ACCESS_CLIENT_ID=<Access 服务凭证 Client ID>
HUB_SYNC_ACCESS_CLIENT_SECRET=<Access 服务凭证 Client Secret>
HUB_SYNC_INTERVAL=60     # 秒；0 = 只手动同步
HUB_SYNC_MODE=both       # both 双向；pull 只拉取（本地做云端的镜像）；push 只推送（本地为准）
```

`docker compose up -d` 重启后，本地 Hub 每 60 秒同步一轮，网页标题栏显示同步状态。云端 Hub 是对端，不需要任何新配置；它的服务凭证需要在 Access 的 Service Auth 策略和 Worker 的 `ACCESS_SERVICE_IDS` 白名单里（可以复用这台电脑已有的凭证，也可以单独建一个只给同步用的）。

### 5.3 第一次同步两个已有数据的 Hub

两边都有数据时，第一次同步会把两边的任务、规则、复盘**合并成并集**（同一个任务编号两边都有时按冲突合并）。先确认这是你想要的：

```bash
# 1. 两边都先导出 JSON 备份（网页“同步与设置 → 下载 JSON 备份”）
# 2. 预览，不写入任何数据
docker compose exec agent-hub node src/cli.js sync --dry-run
# 3. 确认后正式同步
docker compose exec agent-hub node src/cli.js sync
```

网页“同步与设置 → 多端同步”里的“预览”“立即同步”按钮做同样的事。只想让本地成为云端的镜像，用 `HUB_SYNC_MODE=pull`；只想把本地数据推上云端，用 `push`。

### 5.4 机制

- 每次写入文档（含删除）都取一个单调递增的**变更序号**，并记下**来源**：本端修改为空，对端同步来的为对端 Hub 编号。删除留下墓碑，所以删除也能同步。
- 每一轮：发起方从对端拉取“序号大于上次游标、且不是自己推过去的”变更；收集本端“序号大于上次推送游标、且来源是本端”的变更；只有一端改过的直接覆盖另一端，两端都改过的按下面的规则合并后写回两端；最后推进两个游标。
- 推送时带上**基准序号**（发起方拉取时看到的对端序号）。对端在这期间又被别人改过的文档会被拒收，下一轮作为冲突合并，而不是被静默覆盖。推送失败的文档下一轮重试。
- 对端 Hub 换了（例如云端数据重建、编号变化），游标自动作废，从头全量对一遍。

### 5.5 冲突合并

| 情况 | 结果 |
| --- | --- |
| 任务两端都改过 | 状态历史、退回记录取并集；状态取**最后一次流转**；回执、评审、检查结果、执行摘要各取时间更新的一方；验收标准条目相同则合并勾选；其余字段以后修改的一方为准 |
| 设置两端都改过 | Agent 列表、项目取并集；同名项目以后修改的一方为准 |
| 规则、复盘两端都改过 | 保留后修改的版本（规则的“出现次数”取较大值） |
| 一端删除、一端修改 | 保留修改（误删的代价更大）；需要删除就在修改后的一端再删一次 |

每次合并都记入冲突日志（网页“同步与设置”，最多保留 50 条），可以逐条点开核对后清除。

## 6. 安全边界

- **Hub 不能让执行端运行任意命令。** 执行端只处理本机登记过路径的项目，只在任务自己的 worktree 里工作，只运行本机 `runner.json` 里配置的 Agent 命令；提示词是固定模板，只带任务编号；任务编号不符合文件名规则直接拒绝。本机没有用 `--exec` 登记时，即使收到自动执行的派发也只准备工作区。
- **自动执行等于无人值守地给 Agent 编辑权限。** 只对验收标准清楚、风险等级低的任务使用；受保护路径守卫、结束前验证、git 钩子仍然生效，合并仍需人工评审和 `task.sh merge`。
- **同步令牌是对端的完整读写权限。** `HUB_SYNC_TOKEN`、Access Client Secret 只放在 `.env`（已被 Git 忽略）或密码管理器里；云端 Hub 主动发起同步时必须用 Worker Secret，不能写进 `wrangler.jsonc` 的 vars（部署预检会拒绝）。
- **云端 Agent 的环境变量里有 Hub 令牌。** 给每个云端环境单独建 Access 服务凭证并设置到期时间，不用时吊销；不要把令牌写进仓库或提示词。

## 7. 配置参考

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HUB_NAME` | 本地：`本地 Hub`；Cloudflare：`云端 Hub` | 网页标题栏、同步对端显示的名称 |
| `HUB_KIND` | 本地：`local`；Cloudflare：`cloud` | Hub 类型 |
| `RUN_STALL_MINUTES` | `15` | 执行多久没有心跳算停滞 |
| `RUNNER_OFFLINE_SECONDS` | `90` | 执行端多久没有心跳算离线 |
| `HUB_SYNC_URL` / `HUB_SYNC_TOKEN` | 空 | 同步对端地址与对端令牌；都设置才启用同步 |
| `HUB_SYNC_ACCESS_CLIENT_ID` / `_SECRET` | 空 | 对端在 Cloudflare Access 后面时的服务凭证 |
| `HUB_SYNC_INTERVAL` | `60` | 自动同步间隔（秒），`0` 只手动 |
| `HUB_SYNC_MODE` | `both` | `both` / `pull` / `push` |
| `HUB_RETIRED_TO` | 空 | 本 Hub 退役为只读并指向这个地址（一般用 `node src/cli.js retire` 设置，不必写环境变量） |
| `AGENT_HUB_LOCATION` | 自动识别 | 脚本端：强制执行位置 `local` / `cloud` |
| `AGENT_HUB_HOST` | 主机名 | 脚本端：显示的机器名 |
| `AGENT_HUB_RUNNER_FILE` | `~/.config/agent-hub/runner.json` | 执行端配置文件位置 |
| `AGENT_HUB_BASH` | 自动查找 | 执行端运行仓库脚本用的 bash（Windows 上指向 Git Bash） |
| `AGENT_HUB_SPOOL` | `~/.cache/agent-hub/spool` | 上报失败时的暂存目录（最多 500 条）；`AGENT_HUB_NO_SPOOL=1` 关闭暂存 |

## 8. 接口

| 用途 | REST | MCP |
| --- | --- | --- |
| 执行总览 | `GET /api/exec` | `list_runs` |
| 派发 / 取消 | `POST /api/tasks/<id>/dispatch`、`POST /api/runs/<run>/cancel` | `dispatch_task`、`cancel_run` |
| 汇报进度 | `POST /api/tasks/<id>/progress` | `report_progress` |
| 开工 / 接手 | `POST /api/tasks/<id>/start`（task.sh start / attach） | `start_task`（`location`） |
| 执行端 | `POST /api/runners`、`/api/runners/<id>/heartbeat`、`/claim`、`POST /api/runs/<run>/update` | — |
| 同步 | `GET /api/sync/status`、`POST /api/sync/run`（`{"dryRun":true}` 预览）、`DELETE /api/sync/conflicts` | — |
| 同步对端接口 | `GET /api/sync/info`、`GET /api/sync/changes`、`POST /api/sync/apply` | — |

网页实时推送新增 `run`、`runner`、`sync` 三种 SSE 事件。

## 9. 排查

| 现象 | 检查 |
| --- | --- |
| 任务一直“排队中” | “执行”页看是否有登记了该项目、在线的执行端；指定的执行端是否只准备工作区而派发方式是自动执行；`runner.mjs status` |
| 执行端领取后马上失败 | 执行记录的说明会写原因：本机没登记项目路径、仓库没装接入包、Agent 启动命令找不到 |
| 自动执行“失败：没有收到交付回执” | 看 `.agent/run-<执行编号>.log`；Agent 需要按 AGENTS.md 输出 `agent-receipt` 代码块 |
| 一直显示“停滞” | 那台机器上 Agent 是否还在运行；会话结束了但没交回执时，补交回执或重新派发 |
| 执行显示“本机”，实际在云端 | 云端环境没有被自动识别：设置 `AGENT_HUB_LOCATION=cloud` |
| 网络断过一阵后进度对不上 | `hub.sh ping` 看有没有积压，`hub.sh flush` 立即补发 |
| 写入提示“本 Hub 已停用” | 这台电脑还连着退役的本地 Hub：按[云端唯一](CLOUD-ONLY.md#34-切换这台电脑)重新连接 |
| 同步失败：401 | `HUB_SYNC_TOKEN` 要填**对端** Hub 的令牌 |
| 同步失败：要求 Access 认证 / 403 | 服务凭证缺失、过期，或不在对端的 Service Auth 策略与 `ACCESS_SERVICE_IDS` 里 |
| 同步后出现大量“冲突” | 第一次同步两个都有数据的 Hub 时正常；逐条核对冲突日志，确认后清除 |
| 云端看得到进度，但不能取消 | 这次执行由本地 Hub 管理；到执行端连接的 Hub 上取消 |
