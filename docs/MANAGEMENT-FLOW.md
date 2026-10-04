# 管理流程（云端唯一）

适用于 agent-hub 0.3.0。核对日期：2026-10-03。GitHub 会直接渲染下面的 Mermaid 图。

## 1. 总览：谁连到哪里

所有入口都连云端 Hub；本地 Docker Hub 退役为只读，只在迁移时做最后一次同步，或者留作只读镜像。

```mermaid
flowchart LR
  subgraph People["人"]
    Web["浏览器 / 手机<br/>网页工作台"]
  end
  subgraph CF["Cloudflare"]
    Access["Access<br/>邮箱验证码 · 服务凭证"]
    Hub[("云端 Hub · 唯一数据来源<br/>Worker + Durable Object SQLite<br/>任务 · 执行 · 评审 · 规则 · 复盘")]
    Access --> Hub
  end
  subgraph PC["工作站"]
    Agents["Claude Code / Codex / Cursor / Kiro<br/>钩子 · MCP · OTel"]
    Scripts["task.sh · git 钩子<br/>hub.sh：断网暂存，恢复后补发"]
    Runner["runner.mjs 执行端<br/>领取派发 · 建 worktree · 按需启动 Agent"]
  end
  subgraph Remote["云端会话"]
    CA["Claude Code 网页版 / Codex 云端 / Copilot<br/>task.sh attach 接手任务"]
  end
  Local[("本地 Docker Hub<br/>已停用 · 只读")]
  Web -- "邮箱验证码 + Hub 令牌" --> Access
  Agents -- "服务凭证 + Hub 令牌" --> Access
  Scripts --> Access
  Runner -- "心跳 · 领取 · 回报" --> Access
  CA --> Access
  Local -. "迁移时最后一次同步 / 可选只读镜像" .-> Access
```

## 2. 一个任务的完整流程

从建任务到规则沉淀。菱形是需要判断的节点，虚线是经验回流到下一个任务。

```mermaid
flowchart TD
  A["① 建任务<br/>网页 · MCP create_task · task.sh new"]
  B{"规格清楚？<br/>目标 · 验收标准 · 允许范围 · 风险等级"}
  A0["待规格：补充规格"]
  C["待执行"]
  D{"② 怎么开工"}
  D1["本机手动<br/>task.sh start：分支 + worktree + 任务单"]
  D2["派发给执行端<br/>runner 领取：准备工作区 / 自动执行"]
  D3["交给云端 Agent<br/>复制开工提示词 → task.sh attach"]
  E["③ 执行中<br/>会话开始注入任务单 · 守卫拦截受保护路径<br/>钩子事件 = 心跳 · 当前步骤 · 进度"]
  F{"超过 15 分钟没有心跳？"}
  F1["执行停滞 / 失联<br/>进入今日“需要我处理”"]
  H["④ 结束前统一验证<br/>stop-verify，未通过让 Agent 继续修（最多 3 轮）"]
  I{"交付回执"}
  J["需介入"]
  G{"人处理"}
  K["待评审"]
  L["⑤ 机器检查<br/>task.sh check：统一验证 + 越界检查"]
  M{"⑥ 人工评审"}
  R["退回：选原因、写说明"]
  N["⑦ task.sh merge<br/>已合并"]
  Z["已放弃"]
  O["⑧ 复盘<br/>合并率 · 一次通过率 · 成本 · 问题归因"]
  P["规则库<br/>反复出现的问题写进 AGENTS.md 等规则文件"]

  A --> B
  B -- 否 --> A0 --> B
  B -- 是 --> C --> D
  D -- 本机 --> D1
  D -- 执行端 --> D2
  D -- 云端 Agent --> D3
  D1 & D2 & D3 --> E
  E --> F
  F -- 是 --> F1 --> G
  F -- 否 --> H --> I
  I -- "blocked / 验证失败 / 退出无回执" --> J --> G
  G -- "继续 / 重新派发" --> D
  G -- 放弃 --> Z
  I -- done --> K --> L --> M
  M -- 退回 --> R --> D
  M -- 通过 --> N --> O
  M -- 放弃 --> Z
  R --> P
  O --> P
  P -. "下一个任务的任务单与 AGENTS.md" .-> A
```

## 3. 任务状态

```mermaid
stateDiagram-v2
  state "待规格" as spec
  state "待执行" as todo
  state "执行中" as doing
  state "需介入" as help
  state "待评审" as review
  state "已合并" as merged
  state "已放弃" as dropped

  [*] --> spec
  [*] --> todo
  spec --> todo: 规格就绪
  todo --> doing: 开工 / 执行端领取 / 会话开始
  doing --> review: 回执 done
  doing --> help: 回执 blocked · 验证失败 · 退出无回执 · 失联
  help --> doing: 处理后继续 / 重新派发
  review --> doing: 退回修改（记录原因）
  review --> merged: 评审通过 · task.sh merge
  help --> dropped: 放弃
  review --> dropped: 放弃
  dropped --> todo: 重新打开
  merged --> [*]
```

## 4. 执行记录（一次执行尝试）

每个任务同一时间只有一个进行中的执行；退回后再开工是新的一次尝试。

```mermaid
stateDiagram-v2
  state "排队中" as queued
  state "已领取" as claimed
  state "待启动" as ready
  state "执行中" as running
  state "已交付" as done
  state "阻塞" as blocked
  state "失败" as failed
  state "失联" as lost
  state "已取消" as cancelled
  state "已替代" as superseded

  [*] --> queued: 派发
  [*] --> running: 手动开工 / attach / 会话开始
  queued --> claimed: 执行端领取
  queued --> running: 云端 Agent 接手
  claimed --> ready: 工作区就绪（准备工作区）
  claimed --> running: 启动 Agent（自动执行）
  ready --> running: 人启动 Agent
  running --> done: 回执 done
  running --> blocked: 回执 blocked
  running --> failed: 退出无回执 / 启动失败
  running --> lost: 执行端离线
  queued --> cancelled: 取消
  running --> cancelled: 取消 / 任务放弃
  running --> superseded: 同一任务开始了新的执行
  note right of running: 超过 15 分钟没有心跳显示为“停滞”
```

## 5. 派发到执行端：一次完整交互

```mermaid
sequenceDiagram
  autonumber
  actor U as 你（手机 / 网页）
  participant H as 云端 Hub
  participant R as 执行端 runner.mjs
  participant T as task.sh + worktree
  participant A as Agent（Codex / Claude Code）

  U->>H: 派发执行（方式 · 执行端 · Agent）
  H-->>H: 新建执行记录：排队中
  loop 每 30 秒
    R->>H: 心跳（正在跑的执行）
    H-->>R: 需要停止的执行 · 可领取数量
  end
  R->>H: 领取（Hub 内原子完成）
  H-->>R: 执行记录 + 任务单
  R->>T: task.sh start --reuse（分支 + worktree + specs）
  T->>H: 开工 → 待启动
  alt 自动执行（--exec 登记）
    R->>A: 无人值守启动（只放行接入包脚本与 git 命令）
  else 准备工作区（默认）
    U->>A: 在 worktree 里打开 Agent
  end
  A->>H: 钩子：会话开始 · 修改 · 进度（执行中 · 心跳）
  Note over A,H: 断网时 hub.sh 先暂存，恢复后按原始时间补发
  A->>A: 结束前统一验证（stop-verify）
  A->>H: 交付回执（Stop 钩子，执行端从输出兜底提取）
  H-->>U: 待评审（或需介入）
  U->>H: 评审：通过 / 退回（选原因）/ 放弃
  U->>T: task.sh merge → 已合并
```

## 6. 迁移到云端唯一

```mermaid
flowchart LR
  S1["备份两端 JSON"] --> S2["本地 .env 配置 HUB_SYNC_*"]
  S2 --> S3["sync --dry-run 预览"]
  S3 --> S4["retire 云端地址<br/>自动最后同步 · 确认无待推送"]
  S4 --> S5["本地 Hub 只读<br/>写入返回 410 并指向云端"]
  S5 --> S6["每台电脑<br/>connect.mjs 连云端<br/>connect.mjs --remove agent-hub-local"]
  S6 --> S7["执行端 register 连云端"]
  S7 --> S8["docker compose stop<br/>或保留为只读镜像"]
```

详细命令见 [云端唯一：迁移与日常](CLOUD-ONLY.md)，机制见 [执行管理与多端同步](EXECUTION-AND-SYNC.md)。
