# Cloudflare Workers 私人部署

当前账户的核对结果、无自有域名的 `workers.dev` 方案及首次发布顺序，见 [云端准备详细指南](CLOUDFLARE-CLOUD-PREPARATION.md)。该方案无需购买域名。

## 架构与默认保护

浏览器 / Agent → Cloudflare Access → Worker（校验 JWT）→ 个人工作区 Durable Object → SQLite。

Worker 也在身份校验后提供 `public/` 静态资源。`run_worker_first: true` 保证 HTML、JS、健康检查和导出都不能绕过入口保护。后台沿用共享 Express 应用和业务函数，通过官方 Node HTTP 适配层运行；数据库、OAuth 状态、网页登录会话、限流记录和 SSE 广播归属于同一个个人工作区。

此版本面向单用户，主 Hub 令牌仍拥有完整读写权限。机器身份可在 Access 和 `ACCESS_SERVICE_IDS` 中分别撤销；Hub 内部尚没有只读令牌或多用户角色。

当前实例已在 Access 保护下开放 `workers.dev`，预览 URL 关闭，没有自动发布工作流。新实例首次创建应按详细指南先关闭入口，完成 Access 后再开放。缺少 Hub 密钥、HTTPS PUBLIC_URL、Access Team Domain、AUD 或本人白名单时返回 503；缺少或无效的 Access JWT 返回 401；不匹配白名单身份返回 403。任何情况下都不会因校验出错而放行。

## 本地开发

需要 Node.js ≥ 22.5：

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
```

在 `.dev.vars` 中替换示例 HUB_TOKEN，然后：

```powershell
npm run dev:cloudflare
```

访问 `http://127.0.0.1:8788`，使用 `.dev.vars` 的令牌登录。LOCAL_DEV=1 仅允许 localhost / 127.0.0.1 / ::1 请求绕过 Access；Hub 数据接口仍需要令牌或有效会话。这个开关只放在不提交的本地文件，不要在云端添加。

Wrangler 默认将本地 SQLite 保存在 `.wrangler/`，与现有 Docker 数据卷分离。`.dev.vars` 存在时不会使用 `.env` 的本地密钥；集成测试额外禁用了 `.env` 自动读取。

## 云端准备

1. 在 Cloudflare 账户启用 Workers 与 Zero Trust，准备一个该账户管理的自定义域名，例如 `hub.example.com`。先在账户中核对 SQLite Durable Objects 的可用计划和当前额度。
2. 创建 Access self-hosted 应用，覆盖整个 `hub.example.com`，不要只保护 `/api` 或预览环境。Allow 策略只包含本人的邮箱；示例默认 `hio250@163.com`，可使用邮箱 OTP 或绑定身份提供商。不要添加 Everyone 或 Bypass。
3. 从 Zero Trust 配置取得团队域名，例如 `my-team.cloudflareaccess.com`；从 Access 应用取得 AUD（Application Audience）。
4. 修改 `wrangler.jsonc` 的非秘密配置，使用自己账户的 `account_id`；采用自定义域名时关闭 `workers.dev`：

```jsonc
"workers_dev": false,
"routes": [{ "pattern": "hub.example.com", "custom_domain": true }],
"vars": {
  "HUB_INSTANCE": "personal",
  "PUBLIC_URL": "https://hub.example.com",
  "ACCESS_TEAM_DOMAIN": "my-team.cloudflareaccess.com",
  "ACCESS_AUD": "your-application-audience",
  "ACCESS_ALLOWED_EMAILS": "hio250@163.com",
  "ACCESS_SERVICE_IDS": "",
  "OAUTH_ENABLED": "0",
  "HUB_STORE_PAYLOAD": "summary",
  "EVENT_RETENTION_DAYS": "90",
  "SESSION_TTL_SECONDS": "604800"
}
```

上面是替换片段，保留现有 assets、durable_objects、migrations 和其他设置。AUD、团队域名与邮箱不是密钥；Hub 令牌、模型 API Key 和机器 Client Secret 不写入该文件。

`HUB_INSTANCE` 标识现有个人工作区，部署后保持不变；修改它会访问另一个空数据库。保留 migrations 历史，也不要删除或重命名 AgentHub 类。

## 发布

```powershell
npx wrangler login
npx wrangler whoami
npm run preflight:cloudflare
npm run build:cloudflare
npm run deploy:cloudflare -- --secrets-file .cloudflare/bootstrap-secrets.json
```

首次 deploy 创建 Worker、静态资源与 SQLite Durable Object 命名空间。当前 Wrangler 会检查 required Secret：新 Worker 需要通过 `--secrets-file` 一并提供 HUB_TOKEN，不能假设可以先 deploy 再 secret put。随机密钥文件的生成、保存和删除步骤见详细指南；密钥至少 24 字符。若先创建 Worker 再配置 Access，请使用指南里的 `bootstrap:cloudflare` 保持入口关闭。

已有 Worker 的后续发布无需 secrets-file，可直接运行 `npm run deploy:cloudflare` 继承现有密钥和数据库；轮换密钥使用交互式 `npx wrangler secret put HUB_TOKEN`。

`wrangler login` 需要浏览器登录 Cloudflare。可选的非交互部署使用账户的 API Token 环境变量；GitHub origin 或 Hub 访问令牌都不能代替 Cloudflare API Token。

需要模型辅助时，通过 Secret 设置 `LLM_API_KEY`，在 vars 配置 `LLM_PROVIDER`、`LLM_MODEL`、可选 `LLM_BASE_URL`。启用该功能会把网页请求的 prompt 发给选定的服务商。

## 数据迁移与恢复

1. 在现有本地 Hub 的“导出与设置”中导出 JSON，保存于不提交的 `migrate/` 或安全备份目录。
2. 打开云端域名，完成 Access 本人登录，再用云端 HUB_TOKEN 登录 Hub。
3. 在“导出与设置 → 从 JSON 恢复”导入；核对任务、规则、项目和复盘数量与字段。
4. 在确认数据正确前保留原 Docker 卷和备份。部署改造本身不会复制本地数据到云端。

JSON 导入/导出包含任务、规则、项目配置和复盘，不包含事件、Agent 会话、网页会话或 OAuth 状态。云端完整恢复应使用 SQLite Durable Objects 的 PITR/bookmarks 能力并确认账户的恢复窗口；JSON 导出作为业务文档补充备份。更改主 Hub 令牌会使旧网页会话失效，OAuth 访问令牌需另行管理。

## 远程 Agent 与 Access 服务凭证

在 Access 应用增加 Service Auth 策略，只允许具体的 service token。记录 Client ID 与 Client Secret；把 Client ID 同时加入 `ACCESS_SERVICE_IDS`（多个用逗号分隔）。Worker 校验已签名 JWT 的 `common_name`，不会仅凭客户端自报的身份头放行。

本地连接脚本接受 `--access-client-id`、`--access-client-secret`，也接受 `CF_ACCESS_CLIENT_ID` 与 `CF_ACCESS_CLIENT_SECRET` 环境变量。与 `AGENT_HUB_TOKEN` 一起提供后：

```powershell
node kit/connect.mjs --url https://hub.example.com --agents codex,cursor,claude
```

脚本会把 Access 请求头加入 MCP、遥测与项目脚本配置，并把连接配置保存到用户级 `~/.config/agent-hub/env`，Unix 权限 600。首次下载 `/connect.mjs` 也必须通过 Access；已有源码可直接运行上面的本地脚本。

本机 Docker 接入仍可使用 `http://127.0.0.1:8787`，无需 Access 服务凭证。当前 Hub 主令牌没有按设备拆分，撤销设备时应先吊销其 Access 服务凭证；主令牌泄露则需要更换 Hub Secret。

## Claude 云端连接器

代码保留 OAuth + PKCE，且已在本地 Node 和 workerd 中验证完整流程。云端默认 OAUTH_ENABLED=0。

开启 Hub OAuth 不会绕过 Cloudflare Access。Claude 网页/手机的服务器若不能向你的 Access 应用提供可接受的服务凭证，就无法访问严格保护的 MCP/OAuth 地址。当前默认配置不为连接器添加公网 Bypass。需要这种接入时，先验证客户端的自定义请求头能力或另行设计专用入口。

## 发布后的验收

- 未登录、错误身份、只有 Hub 令牌或伪造身份头时，网页、静态 JS、健康检查、API、MCP 和备份都不能读取。
- 本人通过 Access 登录后，Hub 令牌登录和任务读写正常；远程 Agent 同时带有效服务凭证和 Hub 令牌时正常。
- 退出后复用旧 Cookie 返回 401，过期 Cookie 返回 401；更换 Hub Secret 后旧网页会话失效。
- SSE 收到文档变化，Agent 钩子、OTLP、MCP 和接入包下载正常。
- 重新部署后原任务与有效登录态保留；私人响应为 `Cache-Control: private, no-store`。
- 未开启其他公开域名或预览入口，Cloudflare 上没有缓存私人 API 的额外 Cache Rule。

## 已完成的本地验证

2026-09-30：原有 Linux 端到端 57 项通过；安全回归 9 组通过；Node OAuth 14 项通过；真实 workerd 集成 40 项通过（含另一次 OAuth 14 项）；Wrangler dry-run 打包与绑定类型生成通过。测试使用合成数据，不接触部署账户或原有 Docker 数据卷。会话退出和过期也会关闭已连接的 Cookie SSE 数据流。

已在本账户完成 workers.dev 私人生产发布、Access OTP/机器策略验收，以及本机真实远程 MCP 接入和项目/任务登记。没有绑定自有域名；详情与当前版本见云端准备指南，日常操作见[远程管理指南](REMOTE-MANAGEMENT-GUIDE.md)。GitHub CI 仅验证，不自动部署。

## 官方参考

- [Express on Workers](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)
- [SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Access 服务凭证](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)

Cloudflare 处理应用请求，并托管云端数据；这套访问控制用于限制访问者，不提供服务商无法读取内容的端到端加密保证。
