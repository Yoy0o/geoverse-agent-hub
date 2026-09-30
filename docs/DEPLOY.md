# agent-hub 部署与 Agent 接入

> 对应设计文档：研发流程中的 Agent 产出管控方案（claude/agent-dev-governance.md）、Agent 工作台（claude/agent-workbench.md）。
> 本文基于 2026 年 9 月各工具的官方文档编写；各家钩子格式迭代很快，首次接入时按第 8 节逐个验收。

## 1. 它解决什么

原来的 Agent 工作台是 claude.ai 上的一个页面：任务、评审、规则都在，但 Agent 干完活要**人工粘贴回执**，成本要**手填**，Agent 在做什么**看不到**。agent-hub 把工作台搬到自己的机器上，并打通四条通道，让这些事自动发生：

| 通道 | 谁用 | 自动完成什么 |
|---|---|---|
| 钩子（hub.sh） | Claude Code、Codex、Cursor、Copilot、Kiro | 会话开始注入任务单；改受保护路径直接拦截；结束前跑统一验证、不过就让 Agent 继续修；从最后一条回复里提取交付回执，任务自动进入“待评审 / 需介入” |
| MCP（/mcp） | 所有支持 MCP 的 Agent 和 Claude 客户端 | Agent 用 `get_task` 读任务单、`submit_receipt` 交回执；你在手机上的 Claude 里用 `today`、`move_task` 看待办、做评审 |
| OTel（/v1/logs） | Claude Code（成本）、Codex（token） | 每个会话的成本、token 汇总到任务，界面上的“每合并成本”不再靠手填 |
| git 钩子 + task.sh | 任何 Agent、任何人 | 开工（分支 + worktree + 任务单 + 状态）、检查结果、每次提交、合并都回写任务 |

钩子是加速器，兜底的仍然是 git 钩子和 task.sh（禁止提交密钥、Agent 分支禁止提交受保护路径、合并前再验证），对任何 Agent 都生效；hub 挂了，钩子静默跳过，Agent 照常工作。

## 2. 架构

```
┌──────────────────────────── 你的电脑 ────────────────────────────┐
│  Claude Code ─┐                                                 │
│  Codex ───────┤  钩子 → scripts/agent/hub.sh ──┐                 │
│  Cursor ──────┤  MCP（用户级配置）────────────┼──► agent-hub ────┼── SQLite（任务/规则/复盘/事件/会话）
│  Copilot ─────┤  OTel（Claude Code / Codex）──┘   :8787         │     └ 网页：今日/看板/项目/接入/录入/规则库/复盘
│  Kiro ────────┘                                    ▲            │
│  git 钩子 / task.sh ───────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                                                     ▲ HTTPS + OAuth（可选）
                        claude.ai / Claude 手机端 / Cowork 自定义连接器（经 Cloudflare Tunnel）
```

任务与 Agent 会话的关联靠**任务编号**：task.sh 建的分支叫 `agent/<任务编号>-<简述>`，worktree 在 `<仓库>.worktrees/<任务编号>`。hub.sh 每次上报都带上当前分支，hub 据此把会话、事件、成本挂到任务上；OTel 数据按 `session.id` 匹配到同一个会话。

## 3. 选一种部署形态

| 形态 | 适合 | 手机能看 | claude.ai 连接器 |
|---|---|---|---|
| A. 本机 Docker（默认） | 只在这台电脑上写代码 | 否 | 否 |
| B. 家里 / 公司一台常开机器 + Tailscale | 多台电脑共用一个 hub | 是（Tailscale App） | 否 |
| C. B + Cloudflare Tunnel 公网 HTTPS | 想在手机上的 Claude 里直接查任务、做评审 | 是 | 是（OAuth） |

建议从 A 开始，跑顺了再升到 C。

### A. 本机

```bash
git clone <你的仓库>/agent-hub && cd agent-hub     # 或解压交付的 agent-hub.zip
cp .env.example .env
docker compose up -d
docker compose exec agent-hub node src/cli.js token    # 记下 HUB_TOKEN
```

打开 http://127.0.0.1:8787 ，用令牌登录。端口默认只绑定 127.0.0.1。

### B. 常开机器 + Tailscale

1. 机器装好 Docker 和 Tailscale，记下它的 Tailscale 地址（如 `100.x.y.z` 或 `hub.tailnet-xxx.ts.net`）。
2. `.env` 里设 `HUB_BIND=100.x.y.z`（只在 Tailscale 网卡上监听），`docker compose up -d`。
3. 各台电脑的 connect.mjs 都用 `--url http://hub.tailnet-xxx.ts.net:8787`。
4. 手机装 Tailscale App 后浏览器打开同一地址。

想要 HTTPS 可以用 `tailscale serve --bg 8787`，地址变成 `https://hub.tailnet-xxx.ts.net`。

### C. 公网 HTTPS + claude.ai 连接器

claude.ai、Claude 手机端、Cowork 的自定义连接器是从 Anthropic 的服务器访问你的 MCP 地址的，所以 hub 必须有公网可达的 HTTPS 地址，并且走 OAuth（官方文档：连接器支持 OAuth、无鉴权，以及仅对部分组织开放的静态请求头）。

1. Cloudflare Zero Trust → Networks → Tunnels 新建隧道，公共主机名 `hub.example.com` 指向 `http://agent-hub:8787`，复制隧道令牌。
2. `.env`：
   ```
   PUBLIC_URL=https://hub.example.com
   OAUTH_ENABLED=1
   CLOUDFLARE_TUNNEL_TOKEN=<隧道令牌>
   HUB_TOKEN=<足够长的随机串>      # 公网暴露时务必自己设一个长令牌
   ```
3. `docker compose --profile tunnel up -d`
4. claude.ai → 设置 → 连接器 → 添加自定义连接器，地址 `https://hub.example.com/mcp`。授权页会要求输入 HUB_TOKEN。
5. 之后在网页、手机、Cowork 里都能说：“看看 agent-hub 今天要处理什么”“把 T260929-abc 退回，原因是验证不足，备注：缺少超 1 万行的测试”。

也可以只把 `/mcp`、`/.well-known/*`、`/authorize`、`/token`、`/register`、`/oauth/*` 暴露到公网，网页继续走 Tailscale：在 Cloudflare 里对其余路径加 Access 策略即可。

## 4. 迁移原工作台数据

交付包的 `migrate/` 里是 2026-09-29 从 Artifact 工作台导出的数据（18 个任务、4 条规则、5 个项目档案）。任选一种：

- 网页「导出与设置 → 从 JSON 恢复」
- `docker compose cp migrate/workbench-backup-20260929.json agent-hub:/tmp/b.json && docker compose exec agent-hub node src/cli.js import /tmp/b.json`

之后在原 Artifact 页面上的改动不会自动同步过来；迁移后以 hub 为准。备份格式两边相同，需要时可以互相导入。

## 5. 本机接入（每台电脑一次）

```bash
curl -fsS http://127.0.0.1:8787/connect.mjs -o /tmp/c.mjs
node /tmp/c.mjs --url http://127.0.0.1:8787 --token <HUB_TOKEN> --dry-run   # 先看会改什么
node /tmp/c.mjs --url http://127.0.0.1:8787 --token <HUB_TOKEN>
```

它做的事（每个文件改动前都会备份成 `*.bak-agent-hub-时间戳`）：

| 对象 | 改动 |
|---|---|
| 所有仓库脚本 | 写 `~/.config/agent-hub/env`（地址 + 令牌，权限 600）；hub.sh 从这里读，仓库里不放令牌 |
| Claude Code | `claude mcp add-json -s user agent-hub`；`~/.claude/settings.json` 的 `env` 打开 OTel（http/json 发到 hub，日志 5 秒一批） |
| Codex | `~/.codex/config.toml` 加 `[mcp_servers.agent-hub]`（url + http_headers）；没有 `[otel]` 时加上 otlp-http json 导出 |
| Cursor | `~/.cursor/mcp.json` |
| VS Code（Copilot 智能体模式） | 用户目录下的 `mcp.json`（`servers`，`type: http`） |
| Copilot CLI | `~/.copilot/mcp-config.json` |
| Kiro | `~/.kiro/settings/mcp.json`（只读类工具自动批准） |
| Claude 桌面版（可选 `--agents claude-desktop`） | `claude_desktop_config.json` 用 `npx mcp-remote` 桥接到 hub |

不加 `--agents` 时自动检测本机装了哪些。改完重启已打开的 Agent。

## 6. 项目接入（每个仓库一次）

网页「项目」页：填好档案（验证命令、约束、禁区、受保护路径）→ 下载接入包 → `bash agent-kit-<项目>/install.sh <仓库目录>` → 按提示提交。**一定要提交到主分支**，因为 worktree 从主分支创建，钩子和脚本要在任务目录里存在。

接入包内容：

```
AGENTS.md                         项目规则 + 任务约定 + 回执格式（所有 Agent 都读）
CLAUDE.md                         @AGENTS.md
.claude/settings.json             Claude Code 钩子
.codex/hooks.json                 Codex 钩子（需要信任项目）
.cursor/hooks.json                Cursor 钩子
.github/hooks/agent-hub.json      Copilot CLI / 云端 Agent 钩子
.kiro/hooks/agent-hub.json        Kiro 钩子；.kiro/steering/agent-hub.md 补充约定
.gemini/settings.json             Gemini CLI 读取 AGENTS.md
scripts/agent/hub.sh              上报与 API 客户端（只依赖 bash + curl；兼容 macOS 自带 bash 3.2）
scripts/agent/guard.sh            受保护路径拦截（各家拒绝协议统一处理）
scripts/agent/stop-verify.sh      结束前统一验证（各家“继续修”协议统一处理），结果回传
scripts/agent/verify.sh           统一验证入口
scripts/agent/task.sh             new / start / run / brief / check / merge / clean
.githooks/                        pre-commit、commit-msg、pre-merge-commit、post-commit
```

## 7. 各 Agent 的接入细节

### Claude Code

| 环节 | 实现 |
|---|---|
| 规则 | CLAUDE.md 导入 AGENTS.md |
| 任务单注入 | `SessionStart` → hub 返回 `hookSpecificOutput.additionalContext`（startup / clear / compact 时注入，resume 不重复） |
| 拦截 | `PreToolUse`（Edit / Write / MultiEdit / NotebookEdit）→ guard.sh 退出码 2 |
| 结束前验证 | `Stop` → stop-verify.sh，失败退出码 2 让 Claude 继续修，最多 3 次 |
| 回执 | `Stop` 载荷里的 `last_assistant_message` 带 ```agent-receipt 代码块 → hub 解析；或 MCP `submit_receipt` |
| 成本 | OTel 日志事件 `claude_code.api_request` 的 `cost_usd`、token，按 `session.id` 归到任务 |

Claude Code 也支持 `type: "http"` 钩子，可以直接 POST 到 `/hooks/claude-code`，但那样拿不到分支信息，所以接入包统一用 command 钩子转发。

### Codex

| 环节 | 实现 |
|---|---|
| 规则 | 原生读 AGENTS.md |
| 任务单注入 | `.codex/hooks.json` 的 `SessionStart` → `additionalContext` |
| 拦截 | `PreToolUse`（matcher `apply_patch|Edit|Write`）→ guard.sh 从 patch 里解析 `*** Update File:` 路径，返回 `permissionDecision: deny` |
| 结束前验证 | `Stop` → 退出码 2 + stderr |
| 回执 | `Stop` 载荷的 `last_assistant_message`；或 MCP |
| 成本 | OTel（otlp-http，protocol json）只有 token 数；在 `.env` 的 `PRICE_TABLE` 填单价后估算成本 |

注意：项目级 `.codex/` 只有在项目被信任后才加载，首次在仓库里运行 Codex 时选择信任。

### Cursor

| 环节 | 实现 |
|---|---|
| 规则 | 原生读 AGENTS.md |
| 任务单注入 | `sessionStart` → `additional_context` |
| 拦截 | `preToolUse`（matcher `Write|Edit|MultiEdit|StrReplace|Delete`）→ `permission: deny` |
| 结束前验证 | `stop` → `followup_message` 让 Agent 继续修 |
| 回执 | `afterAgentResponse` 的回复文本；或 MCP |
| 成本 | 没有遥测接口，靠回执或手填 |

### GitHub Copilot

- **Copilot CLI 和云端 Agent** 读 `.github/hooks/*.json`：`sessionStart` 注入 `additionalContext`，`preToolUse` 拦截 edit / create，`agentStop` 验证（`decision: block`），回执从 `transcriptPath` 指向的会话记录尾部提取。
- `preToolUse` 是“出错即拒绝”，guard.sh 已保证任何异常都按放行退出。
- **VS Code 智能体模式**：读 AGENTS.md，通过 MCP 读任务单、交回执；本文编写时的官方文档没有说明 VS Code 是否执行仓库的钩子文件，按 MCP 路径处理。
- **云端 Agent** 跑在 GitHub 的沙箱里，访问不到本机 hub；钩子里的验证和拦截照常工作，上报静默跳过。需要上报就用形态 C。

### Kiro

| 环节 | 实现 |
|---|---|
| 规则 | Kiro 自动加载 AGENTS.md；`.kiro/steering/agent-hub.md` 补充 spec 目录约定 |
| 任务单注入 | `SessionStart`（IDE）/ `AgentSpawn`（CLI）→ hub 返回纯文本，Kiro 把退出码 0 的 stdout 加进上下文 |
| 拦截 | `PreToolUse`（matcher 覆盖 write / fs_write 等）→ 退出码 2 |
| 结束前验证 | `AgentStop` → 非零退出码时 stderr 交给 Agent |
| 回执 | **以 MCP `submit_receipt` 为主**（steering 里要求），AgentStop 钩子兜底 |
| 其他 | `PostTaskExecution`：spec 任务完成时记一条事件 |

Kiro 的钩子格式在 2026 年更新为 `.kiro/hooks/*.json`（`version: "v1"`），打开项目后在 Agent Hooks 面板确认 agent-hub 的钩子已启用。

### Claude（网页 / 手机 / Cowork）

走形态 C 的 OAuth 连接器，工具与本机 Agent 相同。适合做的事：看今日待办、评审（`move_task` merge / rework / drop）、新建任务、沉淀规则、生成周复盘素材。本机 Cowork / Claude 桌面版可以用 connect.mjs 的 `--agents claude-desktop` 走 mcp-remote 桥接。

### 其他 Agent

任何能读 AGENTS.md 的 Agent 都能按任务单和回执格式工作：回执可以在网页「录入」页粘贴，git 钩子和 task.sh 照常生效。能配 MCP 的，加上 `http://<hub>/mcp?agent=<名字>` 即可。

## 8. 首次验收清单

按顺序做一遍，每一步都能在网页「接入」页和任务详情「Agent 活动」里看到结果：

1. `bash scripts/agent/hub.sh ping` → “已连接”
2. `task.sh new "接入验收" --allow 'docs/**'`，`task.sh start <编号> accept` → 看板上变成“执行中”，worktree 里有 specs/<编号>.md
3. 在 worktree 里打开 Claude Code，问“当前任务是什么” → 能答出任务编号（SessionStart 注入生效）
4. 让它修改 AGENTS.md 里列出的受保护路径 → 被拦截，活动里有“拦截”
5. 让它在 docs/ 写一个文件然后结束 → 结束前跑验证；最后一条回复带回执，任务变“待评审”
6. 等 10 秒刷新任务 → 用量里出现成本（OTel 生效）
7. `task.sh check`、`task.sh merge` → 任务变“已合并”
8. 换 Codex / Cursor / Copilot CLI / Kiro 各做一次 2–5 步；哪一步不生效，看第 10 节

## 9. 运维

- **备份**：`docker compose exec agent-hub node src/cli.js export > backup-$(date +%F).json`，或网页下载 JSON；数据库在 `hub-data` 卷的 `/data/agent-hub.db`
- **升级**：替换代码后 `docker compose up -d --build`，数据卷不动
- **日志**：`docker compose logs -f agent-hub`
- **事件保留**：默认 90 天（`EVENT_RETENTION_DAYS`）；任务、规则、复盘永久保留
- **隐私**：钩子载荷默认只存工具名、文件路径、命令摘要（`HUB_STORE_PAYLOAD=summary`），不存代码内容和提示词；OTel 默认不记录提示词
- **令牌轮换**：改 `.env` 的 `HUB_TOKEN` 后重启，各电脑重新跑 connect.mjs；网页登录态随之失效

## 10. 排查

| 现象 | 检查 |
|---|---|
| 「接入」页某个 Agent 的钩子一直是“—” | 仓库是否提交了接入包；worktree 是否从提交之后的主分支创建；Codex 是否信任了项目；Kiro 面板里钩子是否启用 |
| 会话开始没有注入任务单 | 当前目录是否在 `agent/<编号>-…` 分支；`bash scripts/agent/hub.sh task` 能否打印编号 |
| 回执没有自动写入 | 回复里是否有完整的 ```agent-receipt 代码块；Kiro / VS Code 改用 MCP `submit_receipt`；兜底在「录入」页粘贴 |
| 成本一直为空 | Claude Code：`~/.claude/settings.json` 的 env 是否生效（新开会话）；协议必须是 `http/json`；Codex 只有 token，需要 PRICE_TABLE |
| Agent 变慢 | 会话开始最多等 6 秒、结束最多 4 秒，其余事件后台发送；`AGENT_HUB_DISABLE=1` 可临时关闭上报 |
| 结束前验证太慢 | `AGENT_SKIP_VERIFY=1` 临时跳过；或把耗时的步骤从 verify.sh 挪到 task.sh check 时再跑 |
| claude.ai 添加连接器失败 | `PUBLIC_URL` 必须是 https 且与浏览器访问的地址一致；`curl https://hub.example.com/.well-known/oauth-protected-resource/mcp` 应返回 JSON |

## 11. 已知限制

- 各家钩子的载荷字段以 2026-09 的官方文档为准，本仓库用模拟载荷做了端到端测试（`bash test/e2e.sh`），尚未在每个 Agent 的真实客户端里逐一跑过，所以第 8 节的验收是必要的。
- Cursor、Copilot、Kiro 没有成本遥测；Codex 只有 token。
- OTLP 只收 JSON（`http/json`），不收 protobuf。
- 单用户设计：一个令牌，没有多账号和权限分级；团队使用时放在 Tailscale 或 Cloudflare Access 后面，或者按设计文档第 6.5 节换成团队级方案。
