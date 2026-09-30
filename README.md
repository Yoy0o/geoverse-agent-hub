# agent-hub

自托管的 Agent 工作台：把原来 claude.ai 上的「Agent 工作台」页面搬到自己的机器上，并让各家 coding agent **自动**上报任务状态、交付回执和成本。

- **一个服务**：Node 22 + SQLite，单容器，`docker compose up -d` 即可
- **Cloudflare 原生部署**：Workers + Durable Objects SQLite，支持同样的 REST、SSE、MCP、钩子与 OAuth；全站默认要求 Access 签名身份，参见 [Cloudflare 部署指南](docs/CLOUDFLARE-DEPLOY.md)
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

## Cloudflare

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars   # 填入独立的本地测试令牌
npm run dev:cloudflare                 # http://127.0.0.1:8788
npm run build:cloudflare               # 校验与打包，不发布
```

云端发布前，按 [部署指南](docs/CLOUDFLARE-DEPLOY.md) 配置自定义域名、Access Team Domain、应用 AUD 与 Hub Secret，再运行 `npm run deploy:cloudflare`。默认关闭 `workers.dev` 和预览 URL；缺少密钥或身份配置时拒绝提供网页与数据。个人数据保存在 SQLite Durable Object 中，部署无需当前电脑保持开机。

网页登录使用随机、持久化、可撤销的会话，默认 7 天有效；退出会使旧 Cookie 立即失效。Agent 仍使用 Hub Bearer 令牌；远程接入可额外传入 Access 服务凭证。

## 验证

```powershell
npm run test:security
node --disable-warning=ExperimentalWarning test/oauth.mjs
npm run build:cloudflare
npm run test:cloudflare
docker build -f test/Dockerfile -t agent-hub:test .
docker run --rm agent-hub:test
```

Linux 上也可直接 `npm test`。测试使用合成数据和隔离的临时存储；私人迁移备份、`.env`、`.dev.vars` 与运行数据不提交到 Git。GitHub CI 自动执行验证，不自动发布云端。

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
