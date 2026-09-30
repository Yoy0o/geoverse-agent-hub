# agent-hub

自托管的 Agent 工作台：把原来 claude.ai 上的「Agent 工作台」页面搬到自己的机器上，并让各家 coding agent **自动**上报任务状态、交付回执和成本。

- **一个服务**：Node 22 + SQLite，单容器，`docker compose up -d` 即可
- **原界面不变**：今日 / 看板 / 项目 / 录入 / 规则库 / 复盘 / 导出，新增「接入」页和任务「Agent 活动」
- **四条接入通道**：MCP（读任务单、交回执）、钩子（注入任务单、拦截受保护路径、结束前验证、回传回执）、OTel（成本 / token）、git 钩子与 task.sh（开工、检查、提交、合并）
- **已适配**：Claude Code、Codex、Cursor、GitHub Copilot（CLI / VS Code / 云端 Agent）、Kiro；Claude 网页 / 手机 / Cowork 通过 OAuth 连接器接入

## 快速开始

```bash
cp .env.example .env            # 按需修改；HUB_TOKEN 留空会自动生成
docker compose up -d
docker compose exec agent-hub node src/cli.js token     # 查看访问令牌
open http://127.0.0.1:8787      # 用令牌登录
```

迁移原 Artifact 工作台的数据：网页「导出与设置 → 从 JSON 恢复」选 `migrate/` 下的备份，或

```bash
docker compose cp migrate/workbench-backup-20260929.json agent-hub:/tmp/b.json
docker compose exec agent-hub node src/cli.js import /tmp/b.json
```

本机接入（每台电脑一次），会把 hub 注册为各 Agent 的 MCP 服务器并打开 Claude Code / Codex 的遥测：

```bash
curl -fsS http://127.0.0.1:8787/connect.mjs -o /tmp/c.mjs && node /tmp/c.mjs --url http://127.0.0.1:8787 --token <HUB_TOKEN>
```

项目接入（每个仓库一次）：网页「项目」页下载接入包，`bash agent-kit-<项目>/install.sh <仓库目录>`，按提示提交。

之后每个任务：

```bash
bash scripts/agent/task.sh start <任务编号> <简述>   # 分支 + worktree + 任务单，hub 标记执行中
bash scripts/agent/task.sh run <任务编号> claude      # 或 codex / cursor / kiro / code
bash scripts/agent/task.sh check <任务编号>           # 验证 + 越界检查
bash scripts/agent/task.sh merge <任务编号>           # 合并，hub 标记已合并
```

完整部署说明（服务器 / 公网 / claude.ai 连接器 / 各 Agent 细节 / 排查）见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 不用 Docker

```bash
npm ci && HUB_DATA_DIR=./data npm start      # 需要 Node ≥ 22.5（内置 node:sqlite）
```

## 目录

```
src/        服务端：server、api（REST + SSE）、mcp、hooks + ingest（钩子归一化）、otlp、oauth、kit（接入包生成）
public/     网页（原工作台移植）+ shim.js（把 window.claude 能力接到 REST / SSE）
kit/        接入包模板：hub.sh、guard.sh、stop-verify.sh、task.sh、verify.sh、git 钩子、install.sh、connect.mjs
migrate/    从 Artifact 工作台导出的数据
test/       端到端测试：bash test/e2e.sh
```
