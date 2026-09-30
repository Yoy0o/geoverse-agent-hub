# 当前账户的 Cloudflare 云端准备指南

核对日期：2026-09-30。目标：单人使用的 Agent Hub；用户目前没有自有域名，采用 Workers + SQLite Durable Objects + Cloudflare Access，使用账户的 `workers.dev` 地址。

## 1. 当前已经确认的内容

| 项目 | 当前值 / 状态 | 依据 |
| --- | --- | --- |
| Cloudflare account_id | `4352e30845d3f1e76df79a75666ba6f8` | 实时控制台及 Wrangler whoami，已纠正最初截图抄录误差 |
| Cloudflare 管理员身份 | OAuth 已核对 | 完整管理员邮箱可在本机 whoami 查看，与 Git/应用邮箱用途不同 |
| Zero Trust 团队名 | `steep-pond-6404` | 截图与实时 organization 配置 |
| Zero Trust 套餐 | Zero Trust Free | 截图；不能据此推断 Workers 套餐 |
| 当前浏览器用户权限 | Super Administrator - All Privileges | 截图；不代表本机 CLI 已获授权 |
| 团队域名 | `steep-pond-6404.cloudflareaccess.com` | 已通过登录态只读查询 Access organization 确认并预填 |
| 自有域名 | 暂无 | 用户明确回复 |
| 应用访问邮箱 | 暂按 `hio250@163.com` | 现有白名单；与 Git 提交邮箱相同，可独立于 Cloudflare 管理员邮箱 |
| Wrangler 本机认证 | 已成功 OAuth 授权 | 实际运行 `npx wrangler login` 和 `whoami` |
| Workers 套餐 | Workers Free，Current plan | 实时 Workers plans 页面 |
| Workers 账户子域 | `libra-liuyb.workers.dev` | 实时 Workers & Pages 的 Account details |
| 当日 Workers 请求 | `0 / 100,000` | 实时 Usage，数值只代表核对时刻 |
| Access 应用/AUD | 应用列表为空，暂无本项目 AUD | 已通过登录态只读查询 Access apps |
| 身份提供商 | 只有一个 type=`cloudflare`，未发现 `onetimepin` | 只读查询身份提供商列表；163 邮箱登录还需设置 |
| Durable Objects | 命名空间列表为空 | 已通过登录态只读查询 namespaces |

截图中的管理员邮箱被截断，现已通过 Wrangler 核对完整管理员身份，本文不重复发布该管理邮箱。截图里“已连接身份提供商”的勾选不能证明能用 `hio250@163.com` 登录；实时查询也确认目前尚无 Access 应用，不能认为私人保护已经生效。

本仓库 Git 操作邮箱仍是 `hio250@163.com`。GitHub 源码仓库目前为公开仓库；应用数据和密钥通过独立的云端身份控制保护，私人导出文件、`.env`、`.dev.vars`、`.cloudflare/` 和运行数据库不提交。

## 2. 无域名方案与私人访问边界

预期入口为：

```text
https://geoverse-agent-hub.libra-liuyb.workers.dev
```

已确认 Workers 账户子域是 `libra-liuyb`，与 Zero Trust 团队名不同。上面的完整地址是准备使用的入口，尚未实际发布。无需购买域名、添加 DNS zone、设置 Tunnel、安装 WARP 或让本地 Docker 持续开机。

访问链路是：浏览器/Agent → Cloudflare Access → Worker 校验签名、AUD 与身份白名单 → Hub 身份验证 → 个人 Durable Object SQLite。静态页面也先经过 Worker。HTTP/SSE/MCP 使用现有实现。

采用单 Worker 的 Access **All traffic** 保护；该模式覆盖生产入口及其关联域名。当前项目使用 SSE，不使用 WebSocket。后续如引入 WebSocket，应重新评估，因为当前 Worker 级 Access 尚不支持 WebSocket。[官方 Workers Access 指南](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

“私人使用”是访问权限限制：只有允许的邮箱/机器身份及有效 Hub 凭证可以读写。域名本身仍是公网可解析地址。Cloudflare 托管数据并处理请求，本项目没有对服务商隐藏内容的端到端加密；因此不能承诺绝对隐私或零风险。

## 3. 套餐、额度和成本核对

已分别核对：Zero Trust Free 和 Workers Free。单人 Access 可使用免费方案；官方当前免费用户额度为 50 人。未来套餐与余量仍以控制台为准。[Cloudflare 套餐页](https://www.cloudflare.com/plans/)

| 服务 | 当前官方 Free 额度 | 对本项目的意义 |
| --- | --- | --- |
| Workers | 100,000 请求/天；每次调用 10ms CPU | 应测真实账户下登录、JWT 校验、导入和 ZIP 下载的 CPU 表现 |
| Durable Objects 请求 | 100,000 次/天 | 同账户其他 DO 也会消耗额度 |
| Durable Objects 时长 | 13,000 GB-s/天 | SSE 长连接使对象保持活动，不按“空闲网页”视为零消耗 |
| SQLite DO 读取/写入 | 5,000,000 读行/天；100,000 写行/天 | 查询扫描和索引维护也会计量 |
| SQLite DO 存储 | 账户合计 5GB | 所有命名空间共同占用，非每个个人工作区 5GB |

SQLite Durable Objects 可以在 Workers Free 上使用，本项目无需改成 D1。免费额度耗尽会导致相应操作失败，不提供无限量保障。Workers Paid 的基础费用目前为每月最低 5 美元，另有超额计费；没有在本次准备中开通付费订阅。[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

按官方 DO 时长计量的 128MB，保守采用 0.128GB 估算，单个对象全天活动约为 `0.128 × 86400 = 11059.2 GB-s/天`，约占免费时长额度的 85%。同一对象并发 SSE 不简单按连接数倍增；新增工作区/其他 DO、请求量与 SQLite 行用量仍需合并评估。这是估算，不是账户实际账单或免费可用性保证。

首次使用建议先维持现有套餐，在 Workers Metrics 查看 CPU、错误率及 DO 用量。若真实调用触及 CPU/其他限额，再决定是否升级；无需为单人访问先升级 Zero Trust。

## 4. 云端需记录的非秘密参数

| 参数 | 填写要求 |
| --- | --- |
| `account_id` | 已填截图账户，登录后检查一致 |
| `ACCESS_TEAM_DOMAIN` | 已实时确认并填入 `steep-pond-6404.cloudflareaccess.com` |
| `PUBLIC_URL` | 目标 `https://geoverse-agent-hub.libra-liuyb.workers.dev`；bootstrap 时保持空，配置 Access 后填写 |
| `ACCESS_AUD` | 本项目 Access 应用的 Application Audience (AUD) Tag，通常为 64 位十六进制字符串 |
| `ACCESS_ALLOWED_EMAILS` | 暂为 `hio250@163.com`；应与 Access Allow 策略一致 |
| `ACCESS_SERVICE_IDS` | 暂空；以后填指定机器 Service Token 的 Client ID，逗号分隔 |
| `HUB_INSTANCE` | 保持 `personal`；更改会访问另一个空数据库 |

`account_id`、团队域名、AUD 和 Client ID 是标识符。`HUB_TOKEN`、Cloudflare API Token、Client Secret、模型 API Key 是密钥，不能放进该表、聊天或 Git。

## 5. 登录及核对账户

在项目目录 PowerShell 中执行：

```powershell
npx wrangler login
npx wrangler whoami
```

本机已完成这一步。后续换电脑或认证失效时重新执行，确认输出包含账户 `4352e30845d3f1e76df79a75666ba6f8`。`wrangler.jsonc` 已固定该账户，避免在多个账户间选择错误。此前提供的 Hub 令牌用于应用访问，不能代替 Cloudflare 管理凭证。无需把 Cloudflare 管理 Token 发送到聊天。

打开 [当前账户控制台](https://dash.cloudflare.com/4352e30845d3f1e76df79a75666ba6f8)，从 Cloudflare One 返回主账户，找到 Workers & Pages：

1. 核对 Workers 套餐与当前使用量，确认允许 SQLite Durable Objects。
2. 已有账户子域 `libra-liuyb.workers.dev`，无需重新注册或改名。
3. 本项目 Worker 尚未创建，暂不开放其 `workers.dev`。
4. 团队域名已确认，后续如果修改团队名，再同步 `ACCESS_TEAM_DOMAIN`。

账户子域决定所有 Worker 的地址，选择后避免频繁改名。[官方 workers.dev 配置](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

## 6. 首次创建 Worker：保持入口关闭

当前仓库的 `workers_dev=false`、`preview_urls=false`、没有 routes，`PUBLIC_URL` 和 `ACCESS_AUD` 为空。先保持这个状态创建 Worker，让后续控制台可以选择它进行保护。此阶段不要导入私人数据。

```powershell
npm ci
npm run test:preflight
npm run preflight:cloudflare -- --bootstrap
npm run build:cloudflare
```

首次部署的必需 Secret 必须随部署提供。本次准备已经在当前电脑生成了 `.cloudflare/bootstrap-secrets.json`，可直接保存密钥后用于首次上传；不要重复生成。换电脑且尚无该文件时，可执行下面的生成命令，不显示密钥、不覆盖已有文件：

```powershell
npm run secret:cloudflare
```

文件为明文且目录已被 Git 忽略。只在本机编辑器中查看，把 HUB_TOKEN 存入自己的密码管理器；不要贴进终端记录或聊天。Windows 上 Node 的 `mode` 参数不能代替 NTFS 权限控制，应确保目录仅由可信本机用户访问。

完成保存后执行首次云端创建（下面命令会修改 Cloudflare 云端资源）：

```powershell
npm run bootstrap:cloudflare -- --secrets-file .cloudflare/bootstrap-secrets.json
```

Wrangler 创建 Worker、上传静态资源、执行 v1 migration 建立 SQLite DO 命名空间，并设置云端 Secret；无需手工创建 D1 数据库。bootstrap 的检查要求入口保持关闭且 URL/AUD 为空，应用代码也因此拒绝云端请求。

确认上传成功且密钥已安全保存后，只删除这份本机明文文件：

```powershell
Remove-Item -LiteralPath .cloudflare/bootstrap-secrets.json
```

若上传失败，先排查错误，保留密钥文件用于重试；不要重新生成并丢失已上传的密钥。首次上传不能照旧“先 deploy、再 secret put”：当前 Wrangler 对新 Worker 的 required Secret 会在部署前检查。[官方 Secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)

## 7. 创建本人的 Access 保护

实时身份提供商列表没有 `onetimepin`。如果继续使用 `hio250@163.com`，先在 Zero Trust → Integrations → Identity providers 添加 One-time PIN，并允许本项目使用它；实际验证能收到验证码并完成登录。[官方 OTP 配置](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)

然后在主控制台 Workers & Pages → `geoverse-agent-hub` → Access：

1. 选择 **Protect this Worker behind Access**。
2. 范围选 **All traffic**，不要只选 Previews only。
3. 身份策略使用 **Allow**，Include 选择 **Emails**，只填 `hio250@163.com`。
4. 若默认提供“允许账户成员”的快捷策略，应改为上述明确邮箱策略，否则管理员邮箱与应用邮箱可能不一致。
5. 会话时长可先设 24 小时；应用内部 Hub 会话默认 7 天，两个会话分别校验。
6. 应用保护后，到 Zero Trust → Access controls → Applications 找到对应应用并检查策略，不添加 Everyone、Bypass 或整邮箱域名的宽泛授权。

Worker 级保护操作见 [官方指南](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。它与 Worker 内部 JWT 校验共同工作，不能用“有 Hub Token”来省略 Access。

在对应应用的 Configure → Additional settings 复制 **Application Audience (AUD) Tag**；它不是应用 UUID、团队名或 service token。写入 `wrangler.jsonc` 的 `ACCESS_AUD`。删除重建 Access 应用会改变 AUD，届时必须更新 Worker 配置。[官方 AUD 获取和 JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

如果界面没有 Worker 的 Access tab，按官方 hostname-based 方式为实际完整 `workers.dev` 主机名创建 self-hosted Access 应用，保护整个主机，不限定 `/api`；核对实际请求确实经过 Access 后再开放入口。不要用空 AUD 或 Bypass 解决界面差异。

## 8. 填配置并开放入口

Access 已建立后，只修改以下非秘密配置，保留所有已有 bindings、migrations 与其他 vars：

```jsonc
"workers_dev": true,
"preview_urls": false,
"vars": {
  "PUBLIC_URL": "https://geoverse-agent-hub.libra-liuyb.workers.dev",
  "ACCESS_TEAM_DOMAIN": "steep-pond-6404.cloudflareaccess.com",
  "ACCESS_AUD": "<刚复制的真实 AUD>",
  "ACCESS_ALLOWED_EMAILS": "hio250@163.com"
}
```

这是替换片段，不能用它覆盖整个 vars。无自有域名方案不添加 routes；不向云端上传 `.dev.vars`，不添加 `LOCAL_DEV`。浏览器控制台修改 vars 后也应同步本地配置，避免下一次 Wrangler 部署覆盖。

```powershell
npm run preflight:cloudflare
npm run build:cloudflare
npm run deploy:cloudflare
```

生产 preflight 会拒绝空/占位 AUD、不匹配的 URL、预览入口、LOCAL_DEV、写入 vars 的密钥及未经 Worker 校验的静态资源。它只检查本地配置，不证明远程 Access 策略、Secret 或 Workers 套餐正确；这些由上面的控制台核对和下面的真实验收确认。既有 Worker 更新会继承已设置的 HUB_TOKEN。

## 9. 私人访问验收后再迁移数据

1. 用未登录的无痕窗口访问入口：应先到 Access 登录或拒绝页，不能直接打开 Hub 静态页面。
2. 同样测试 `/shim.js`、`/api/health`、`/api/export`、`/mcp`。Access 可返回登录重定向或拒绝状态；关键是没有取得私人内容，而非所有匿名请求必须固定 401。
3. 用非白名单邮箱尝试登录，Access 应拒绝；即便误放行到 Worker，Worker 邮箱白名单也应拒绝。
4. 用 `hio250@163.com` 完成 Access 登录，再用独立云端 HUB_TOKEN 登录 Hub；创建一个测试任务，核对读取、更新、SSE 推送和导出。
5. 检查私人响应的 `Cache-Control: private, no-store`，退出 Hub 后旧 Cookie 和原 SSE 连接失效。
6. 再部署一次，确认测试任务仍存在。预览 URL 保持关闭，检查 Domains & Routes 没有其他未经保护的入口。
7. 看 Workers Metrics / Logs，检查 CPU 超限、JWT 错误、DO/SQLite 用量；日志不要记录 Token、Cookie 或导出正文。

通过后，从现有本地 Hub 网页导出 JSON，保存到不提交的 `migrate/`，在云端“导出与设置 → 从 JSON 恢复”导入。迁移时以最新本地导出为准，逐项核对任务、规则、项目和复盘的数量与字段。

JSON 迁移覆盖任务、规则、项目配置和复盘，不迁移事件、Agent/网页会话或 OAuth 状态。保留原 Docker 数据卷和独立备份，直到云端恢复验证完成。SQLite DO 的 PITR 恢复窗口应按账户实际能力核对，代码回滚不等于数据回滚。不要通过删除 Worker、DO 类或修改 HUB_INSTANCE 来排查空数据。

## 10. 远程 Agent 接入与后续维护

每台需要远程接入的机器创建独立 Access service token，并在该应用配置只允许指定 token 的 **Service Auth** 策略。Client ID 加入 `ACCESS_SERVICE_IDS`，Client Secret 保存在该机器的密码管理器/本地环境中。与 HUB_TOKEN 一同提供：

```powershell
node kit/connect.mjs --url https://geoverse-agent-hub.libra-liuyb.workers.dev --agents codex,cursor,claude
```

脚本读取 `AGENT_HUB_TOKEN`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`。不建议把密钥写在命令参数里。无人值守 Agent 不使用邮箱 OTP 会话作为永久凭据。机器撤销先吊销对应 service token；主 Hub 令牌没有只读/设备级权限，泄露时需轮换。[官方 service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

已有 Worker 的 Hub Secret 轮换用 `npx wrangler secret put HUB_TOKEN` 交互输入，随后更新各机器。云端默认 OAuth 关闭；Claude 网页等连接器如果不能发送 Access 服务凭证，当前严格保护的入口无法直接接入，不能通过开放全站解决。

定期导出业务 JSON 并存于自己的备份位置。后续有自有域名时，可改为 Custom Domain + `workers_dev=false`，同步 PUBLIC_URL 和对应 Access 保护；不要改 HUB_INSTANCE 或删除 migration 历史。GitHub CI 目前只验证，不自动发布云端。

## 11. 本次准备完成范围

- 已通过实时控制台和 Wrangler 锁定正确 account_id，确认 Workers Free、真实账户子域、团队域名、空 Access 应用列表和空 DO 命名空间。
- 已提供无自有域名的 Workers + Access 发布顺序及密钥处理步骤。
- 已增加 bootstrap/生产部署前配置检查，并接入 npm 发布命令和 CI。
- 本机 Wrangler 已完成 OAuth 授权；配置仍保留关闭入口的状态，尚不存在的 AUD 保持空。
- 已在不提交的 `.cloudflare/bootstrap-secrets.json` 生成独立云端 Secret 文件，验证不会覆盖已有密钥；还未上传云端。请在本机保存到密码管理器后再发布。
- 本次未实际创建 Worker、Access 策略或付费资源，未迁移私人数据。仍需创建关闭入口的 Worker、配置 OTP/Access、取得 AUD、设置独立云端 Secret，才能完成真实发布和访问验收。

## 12. 借鉴官方 Agent Setup 提示

已读取用户提供的 [Cloudflare 官方 Agent Setup 提示](https://developers.cloudflare.com/agent-setup/prompt.md)，采用适合本机 Codex 的配置：

| 连接名称 | 官方 URL | 用途 |
| --- | --- | --- |
| cloudflare | `https://mcp.cloudflare.com/mcp` | Cloudflare API 操作，已完成 OAuth |
| cloudflare-docs | `https://docs.mcp.cloudflare.com/mcp` | 官方文档，无需 OAuth |
| cloudflare-bindings | `https://bindings.mcp.cloudflare.com/mcp` | Workers 绑定和资源配置，已完成 OAuth |
| cloudflare-builds | `https://builds.mcp.cloudflare.com/mcp` | 构建管理，已完成 OAuth |
| cloudflare-observability | `https://observability.mcp.cloudflare.com/mcp` | 日志与运行指标，已完成 OAuth |

五个连接已注册到本机用户级 Codex 配置 `~/.codex/config.toml`，修改前已在同目录创建带时间戳的备份，原有 QGIS 连接保留。当前会话已有 Cloudflare/Workers/Wrangler 等技能，直接复用，没有重复安装另一套全局技能。项目已有 Wrangler，未安装可选 beta `cf` CLI，也未修改用户级 AGENTS.md。

五个连接均已完成必要的准备：四个账户连接的 OAuth 进程返回 Successfully logged in，文档连接不需要登录，并通过用户环境的 `codex mcp list` 核对配置。当前会话不会自动获得新增 MCP 工具，重启/重新打开 Codex 后加载；后续认证过期时再对相应服务器执行 `codex mcp login <名称>`。这些管理连接不代表应用已部署。[Codex MCP 官方说明](https://developers.openai.com/codex/mcp)

Wrangler 登录、Cloudflare MCP 登录、浏览器 Access 登录和 Hub 登录是不同认证层。开发管理连接的 OAuth 不可替代应用访问的 Access AUD、白名单和 HUB_TOKEN。
