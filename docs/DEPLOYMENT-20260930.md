# Agent Hub 部署验收记录

验收日期：2026-09-30（Asia/Shanghai）。结论：满足本机单用户部署条件，已完成部署与数据迁移。

## 项目现状

- 运行版本：0.1.0；Node.js + Express + SQLite，单容器部署。
- 已实现今日、看板、项目、接入、录入、规则库、复盘、导出与设置八个视图。
- 已实现 REST / SSE、MCP Streamable HTTP、Agent 钩子、OTLP JSON、接入包生成、导入导出和可选 OAuth。
- 当前目录是交付源码目录，没有 Git 元数据；无法据此确认分支、提交或远端发布状态。

## 当前部署

| 项目 | 验收结果 |
| --- | --- |
| 网页 | http://127.0.0.1:8787/ |
| MCP | http://127.0.0.1:8787/mcp |
| 容器 / 镜像 | agent-hub / agent-hub:0.1.0 |
| 镜像 ID | sha256:d23c6b4c8c49208aa196e543cd00c472ac5b05e56fd34ac86bc05dea6790f55e |
| 对外绑定 | 仅 127.0.0.1:8787 |
| 容器运行用户 | node，非 root |
| 健康检查 | healthy，连续失败数 0 |
| 重启策略 | unless-stopped |
| 持久化卷 | geoverse-agent-hub_hub-data，挂载至 /data |
| 数据库 | /data/agent-hub.db；PRAGMA integrity_check = ok |
| 访问令牌 | 已自动生成，持久化于 /data/hub-token；本文不包含令牌 |
| 配置 | .env，由 .env.example 初始化 |

`unless-stopped` 在 Docker 引擎启动后生效；本次未修改 Windows 或 Docker Desktop 的登录启动设置。

## 验证证据

- Compose 配置校验通过，正式镜像构建成功。构建过程的 npm 依赖审计报告为 0 个漏洞；这不是独立的全面安全审计。
- 服务端各 JavaScript 文件、shim.js、页面内联 JavaScript 的语法检查通过。
- 独立一次性 Linux 容器中运行 `bash test/e2e.sh`：57 项通过，0 项失败。
- 同一验证容器中运行 `node test/oauth.mjs`：14 项 OAuth 检查全部通过。
- 测试覆盖备份导入、接入包安装、临时 Git 仓库及 worktree、任务 start/check/merge、模拟多 Agent 钩子、回执、受保护路径、OTel 成本、MCP 和接入配置生成。
- 正式服务未授权读取任务返回 401；Bearer 令牌读取任务、配置和能力成功。
- Playwright 通过实际登录表单登录，网页显示“已同步”；八个视图均成功渲染，验收脚本未捕获 pageerror，Cookie 鉴权成功。
- 已重启正式容器并再次等待健康检查，令牌登录态和迁移数据均正常恢复。
- 页面首次未登录时的 401，以及人为重启时断开的 SSE，是此次验收操作的预期结果。

## 数据迁移和备份

从 `migrate/workbench-backup-20260929.json` 导入新建的空数据卷：

- 18 个任务：13 个待规格、5 个待执行。
- 4 条规则，均待写入项目规则文件。
- 5 个项目档案。
- 0 个复盘。

部署后已导出 `output/deployment/post-deploy-backup-20260930.json`，逐一校验了原备份中任务、规则和复盘的所有字段，无缺失或变更。

看板截图：`output/playwright/agent-hub-board.png`。

## 尚待接入的可选能力

- 五个项目的 Agent 接入状态均为 0/5。现有测试采用模拟载荷；实际客户端的 MCP、钩子和遥测仍需按 `docs/DEPLOY.md` 第 8 节验收。
- 尚未运行本机 `connect.mjs` 或安装各业务仓库接入包，也未修改用户级 Agent 配置或其他项目。
- 公网 HTTPS、手机访问和 Claude 网页连接器未启用，仍缺少目标域名、PUBLIC_URL 与 Cloudflare 隧道配置。
- LLM 辅助功能未配置；普通任务、规则、回执和导出功能可用。
- 当前为单用户令牌模式，没有多账号或角色权限。
- 车辆追踪项目尚未配置统一验证命令；这是该项目执行 Agent 任务的待办，不阻塞 Hub 服务启动。

## 本机操作

在项目目录的 PowerShell 中执行：

```powershell
Set-Location D:\workspace\geoverse-agent-hub
docker compose ps
docker compose exec -T agent-hub node --disable-warning=ExperimentalWarning src/cli.js token
```

用上面返回的令牌登录网页。备份与更新：

```powershell
docker compose exec -T agent-hub node --disable-warning=ExperimentalWarning src/cli.js export /tmp/backup.json
docker compose cp agent-hub:/tmp/backup.json ./output/deployment/backup.json
docker compose up -d --build --wait
```

数据保存在命名卷中。停止服务可用 `docker compose stop`；保留数据时不要使用 `docker compose down -v`。

本次新增 `.gitignore`，并补充 `.dockerignore`：排除本地配置、依赖、数据库、浏览器会话和验收产物，避免后续提交或构建打包这些文件。

