# Cloudflare 部署与私人使用评估

评估日期：2026-09-30（Asia/Shanghai）。范围：当前交付源码、脱敏后的本地配置、现有服务的匿名访问行为，以及 Cloudflare 官方文档。此次没有修改业务代码、启用 Tunnel、部署云端服务或修改 Cloudflare 策略。

后续更新：本文件保留改造前的评估证据。随后已完成 Workers + Durable Objects SQLite 适配、会话撤销与过期检查、私人响应禁用缓存、令牌日志修复和 Access 服务凭证接入；最新操作说明与验证结果见 [Cloudflare 部署指南](CLOUDFLARE-DEPLOY.md)。尚未实际发布云端。

## 结论

当前项目适合通过 **现有 Docker 服务 + Cloudflare Tunnel + Cloudflare Access** 提供私人远程访问。项目已预留 Tunnel 服务，部署改动主要在配置与身份策略；若本机 Agent 继续使用 localhost，现有接入脚本可以沿用。

如果要求“电脑关机后依然运行，应用和数据库全部托管在 Cloudflare”，当前源码不能直接完整部署，需要适配 Workers、持久化数据库、实时推送和定时清理。推荐先验证 Workers + Durable Objects SQLite 的单用户方案，也可以使用 D1 配合独立的实时广播组件。这里只评估架构可行性，尚未完成迁移验证。

“只有本人或本人授权的客户端能访问”可以通过身份白名单、应用鉴权和封闭源站实现；目前尚未配置和验收这套保护，不能声称已经保证公网私人使用。Cloudflare 会处理通过其 HTTP 服务的请求，私人访问也不等于第三方无法接触内容。

## 部署路径对比

| 路径 | 当前代码的适用程度 | 主要工作 | 运行条件 |
| --- | --- | --- | --- |
| Docker + Tunnel + Access | 高，已有 Compose 模板 | 域名、Tunnel、Access 白名单、HTTPS 地址；远程 Agent 还需机器身份接入 | 原服务主机、Docker 和网络持续运行 |
| Workers + 托管数据库 | 可行，不能直接完整发布 | Worker HTTP 入口、存储接口、事务、SSE 广播、清理任务、密钥和部署配置 | 改造后可脱离当前电脑 |
| Cloudflare Containers | 镜像可作为迁移起点，持久化不满足现状 | Worker/容器路由、Access、外部持久存储与生命周期恢复 | 不能依赖目前的 /data Docker 卷 |
| Pages / 静态资源托管 | 可托管网页资源，不能独立替代整个服务 | API 同源代理或前后端分离适配，后端仍需部署 | 单独上传 public 不会得到完整 Hub |

Cloudflare 当前已有 Express 部署到 Workers 的官方教程，因此 Express 本身不是必须重写的理由。该项目的关键差异是本地 SQLite、文件持久化、进程内事件广播和常驻定时器。[官方 Express 教程](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)

Workers 的文件系统是虚拟文件系统，可写临时目录不持久，不能承接现有数据库文件与自动生成的 hub-token。[Workers 文件系统](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)

Cloudflare Containers 的容器磁盘是临时的，休眠后重新启动会得到镜像定义的全新磁盘。当前 Dockerfile 中的 VOLUME 声明不能据此被视为 Cloudflare 的持久卷。SQLite 数据与令牌必须先改为可靠的外部持久化；不应直接把现有数据库放在临时磁盘上投入使用。[Containers FAQ](https://developers.cloudflare.com/containers/faq/)

## 当前代码与配置证据

- `src/db.js:6–13` 使用 `node:sqlite` 的 DatabaseSync 和本地数据库文件；事务通过同步回调执行。
- `src/config.js:10–20` 在本地目录创建数据与令牌文件。
- `src/db.js` 通过单进程 EventEmitter 发出文档和事件变化；`src/api.js:47` 的 SSE 订阅这个事件源。迁到多个 Worker 实例后，需要统一协调广播或改成可靠的拉取同步。
- `src/server.js:53` 的定期清理依赖常驻进程，应在 Workers 方案中迁到 Cron/Alarm 等生命周期合适的机制。
- `docker-compose.yml:14` 默认映射到 `127.0.0.1`；同一文件已有可选 `cloudflared` 服务，隧道指向 Docker 内部的 `http://agent-hub:8787`。
- 本地 `.env` 当前设置 `HUB_BIND=127.0.0.1`、`OAUTH_ENABLED=0`、`HUB_STORE_PAYLOAD=summary`；公网地址、Tunnel 令牌与 LLM 配置尚未设置。HUB_TOKEN 留空表示由程序生成，不表示无鉴权。
- 当前没有 Wrangler 配置或 Worker 导出入口。

## 匿名访问实测

对当前 `http://127.0.0.1:8787` 服务发起未带令牌或 Cookie 的请求：

| 请求 | 状态 | 含义 |
| --- | --- | --- |
| GET / | 200 | 静态页面可匿名下载，不等于任务数据可匿名读取 |
| GET /api/health | 200 | 返回版本和文档、事件、会话数量 |
| GET /api/docs/tasks | 401 | 任务文档受鉴权保护 |
| GET /api/export | 401 | 备份导出受鉴权保护 |
| GET /api/stream | 401 | 实时数据流受鉴权保护 |
| POST /mcp（initialize） | 401 | 实際 MCP 调用受鉴权保护 |
| GET /mcp | 405 | 无状态 MCP 不接受 GET；不是绕过鉴权的证据 |
| GET /.well-known/oauth-authorization-server | 404 | 与当前 OAuth 关闭配置一致 |

现有代码还保护了钩子、OTLP、接入包、配置、导入等数据接口。`/connect.mjs` 是有意公开且不含密钥的接入脚本。把整个主机名放在 Access 后，才能同时保护网页外壳与健康检查信息。

## 用户授权令牌后的补充实测

用户提供 Hub 访问令牌后，仅用于内存中的请求鉴权，没有写入本文件或保存下载的数据。此令牌用于 Hub 应用认证，不是 Cloudflare 账户 API 令牌。

- Bearer 鉴权读取 capabilities、任务、规则、复盘、项目配置、事件、Agent 状态和导出均返回 200。当前共有 18 个任务、4 条规则、5 个项目、0 个复盘；LLM 与 OAuth 均关闭。
- MCP initialize 和 tools/list 均返回 200，列出 13 个工具，包含读任务与创建、更新、移动任务等写入工具。没有调用修改任务的工具。
- 错误令牌读取任务、事件、项目接入文件，或向 Codex 钩子与 OTLP logs 提交空载荷，均返回 401。
- 网页登录成功，Cookie 带 HttpOnly、SameSite=Lax、90 天 Max-Age。当前本机 HTTP 配置下没有 Secure；发布 HTTPS 时必须正确设置 PUBLIC_URL。
- Cookie 读取任务成功。对必定无效的集合路径发起 PUT：未带 CSRF 头返回 403，带正确头返回 400 bad path，未写入文档。这验证了现有 REST 写请求的 CSRF 检查。
- **退出登录后复用本次测试自己的旧 Cookie，GET /api/capabilities 仍返回 200，鉴权方式为 cookie。** 这确认了服务端未撤销会话的问题；仅减少浏览器 Cookie Max-Age 不能解决被复制 Cookie 的有效期或退出撤销。
- 任务、配置、事件和导出等本次读取的私人响应没有 Cache-Control 或 Vary。当前未观察到缓存泄露；Cloudflare 部署时应明确禁止私人响应被共享缓存。
- JSON 导出的顶层字段是 app、version、exportedAt、config、tasks、rules、retros，不包含事件、会话或 OAuth 状态。
- 检查后健康接口仍报告 23 个文档、0 个事件、0 个会话；本次未改变业务数据。

## 私人使用需要完成的配置与改造

1. **网页身份白名单。** 在 Access 中只允许本人指定身份登录，未匹配身份拒绝；不要以隐藏网址或允许所有有效邮箱代替白名单。认证通过后仍保留 Hub 的应用鉴权。
2. **保持源站封闭。** 继续只映射 localhost，远程流量经 Tunnel 进入，不额外开放公网 8787。Tunnel 创建的是向 Cloudflare 发起的出站连接。[Tunnel 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
3. **设置正确的 HTTPS PUBLIC_URL。** 当前 Cookie 的 Secure 属性由这个配置决定。云端迁移时还应将令牌/API 密钥放入服务端 Secrets。
4. **适配机器访问。** 本机 MCP、钩子和 OTel 可继续连接 localhost。跨设备客户端若经 Access，需要增加服务凭证或使用私有网络。当前 `kit/connect.mjs` 和 `kit/scripts/hub.sh` 只发送 Hub 的 Bearer 令牌，没有生成 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 请求头；仅启用浏览器 Access 会导致这些请求被登录页面阻挡。[Access 服务凭证](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
5. **改进令牌与会话控制。** 当前所有客户端共享完整权限令牌，没有按设备、只读或写入范围拆分。网页登录 Cookie 的值由主令牌固定派生，服务端没有独立会话到期和撤销记录；退出仅清除浏览器 Cookie。建议改为可撤销、服务端检查有效期的随机会话，并支持设备令牌分别吊销。
6. **控制缓存、日志与备份。** 私人 API、导出和用户数据不配置共享缓存；补充敏感响应的 no-store 策略。首次生成 Hub 令牌会写入服务启动日志，需控制日志读取与保存。完整灾备要覆盖 SQLite、事件和 OAuth 状态：目前网页 JSON 导出只含任务、规则、复盘和项目配置，不能替代整个数据库备份。
7. **验证所有入口。** 使用未登录浏览器、错误身份和无令牌客户端测试网页、API、SSE、MCP、钩子和导出；确认源站不能绕过身份策略。若采用 Workers，应保护生产和预览入口，或禁用不需要的公开入口。[Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

上述第 1–4 项及入口验收是推荐 Tunnel 方案的落地重点。第 5 项的退出不撤销问题已实测确认，建议公网使用前修复；第 6 项应同时落实私人响应缓存策略、令牌日志管理和完整备份。

## Claude 网页与手机连接器

当前项目支持可选的 OAuth + PKCE，并要求输入 Hub 主令牌才能批准授权。但该应用 OAuth 与 Cloudflare Access 是两层独立认证。

若 Claude 的云端客户端只能完成 Hub 的 OAuth，不能提供 Access 所需的身份或服务凭证，把整个域名放在交互式 Access 登录后可能阻断连接器。应验证客户端能力；需要保留云端连接器时，可以仅为 MCP/OAuth 的必要路径设计独立策略，数据调用仍由 Hub OAuth 鉴权，并对授权与注册端点限速。不要为了连接器放行整个管理网页和 REST API。

这意味着 MCP/OAuth 协议入口可能需要公网可达，但可达不代表匿名拥有数据权限。授权后的连接器能读写当前 Hub，现状没有单独的只读连接器权限。

## 数据隐私边界

- 使用 Tunnel 时，数据库仍位于自己的服务主机，Cloudflare 转发应用流量；使用 D1、Durable Objects 或 R2 时，相应数据会托管到 Cloudflare。
- Cloudflare HTTP 代理在边缘终止 TLS 并处理请求，访问白名单不提供“Cloudflare 无法读取应用内容”的保证。[Cloudflare TLS 概念](https://developers.cloudflare.com/ssl/concepts/)
- `HUB_STORE_PAYLOAD=summary` 仍存文件路径、命令片段等摘要，代码没有专门的密钥脱敏。设为 `none` 只是不保存原始/结构化载荷，事件摘要、任务、回执和会话元数据仍会保存。
- 当前 LLM 辅助关闭；启用后 `/api/sample` 会把提交的 prompt 发送给配置的模型服务。连接器获得的数据也会交给被授权的外部客户端。
- 网页目前引用 Google Fonts，会发起第三方字体请求；严格减少第三方请求时应改为本地字体或系统字体。这一请求本身不表示任务内容被发送给 Google。
- 如果要求内容始终只留在自己的设备，并避免 Cloudflare 处理应用流量，应继续本地使用或另行设计端到端加密的私有网络访问。

## 验证范围与限制

此次完成源码与配置检查、匿名/错误令牌访问实测、有效令牌读取、网页 Cookie 与退出检查、REST CSRF 拒绝检查、MCP 初始化与工具列举，以及官方平台资料核对。未连接 Cloudflare 账户，未部署 Workers/Containers，未验收 Access 策略或真实远程 Agent/Claude 连接器。

现有 OAuth 回归脚本尝试运行时因宿主工作区缺少 `@modelcontextprotocol/sdk` 依赖而未启动；因此此次没有重新验证 OAuth 完整流程。历史本机部署验收记录中的通过结果属于之前的验收证据，不能替代这次 Cloudflare 环境验收。

Docker 容器状态查询在当前执行权限下不可用；当前监听与持久化配置依据 Compose 和历史部署记录，服务在线及匿名鉴权结果依据此次 HTTP 实测。

建议选择：近期个人远程使用采用 **Docker + Tunnel + Access**；明确要求关闭本机后仍可用，再进行 **Workers + 持久化数据库** 迁移。两条路径都必须在发布前完成未授权访问与接入兼容性验收。
