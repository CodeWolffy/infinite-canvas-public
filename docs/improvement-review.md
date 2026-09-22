# 项目优化点与可扩展功能清单

审计基线为 `main` 分支 `7608911`。所有条目均已在代码中核实，行号以当前工作区为准。优先级：P1 建议本迭代处理，P2 下个迭代，P3 择机清理。

## 一、后端（server/）

### 代码结构

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| B1 | 路由注册函数过长，业务逻辑内联在闭包中，难以单测 | `adminRoutes` 444 行（admin.go:71-513）、`contentRoutes` 271 行（content.go:56-350）、`executeTask` 268 行（worker.go:310-576）、`streamText` 192 行（text_stream.go:153-344） | handler 只做参数绑定，逻辑下沉为可测函数；`executeTask` 拆成选渠道、占槽、执行、结算四步 | P2 |
| B2 | 全局用 `Row = map[string]any` + `SELECT *`，列名拼写与类型错误只能运行期发现 | app.go:59、app.go:295-321；`SELECT *` 约 43 处 | 核心表（tasks、channels、wallets、orders）引入结构体 + `pgx.RowToStructByName` | P2 |
| B3 | 「渠道可用」判定 SQL 复制 7 处且不一致：用户模型列表比任务创建少两个条件，会列出已自动停用或无可用 Key 的模型 | content.go:60 只查 `status='active' AND deleted_at IS NULL`；generation.go:49 额外要求 `auto_disabled_at IS NULL` 与存在活跃 Key；worker.go 多处各自一份 | 抽成视图 `available_model_channels` 或 SQL 片段常量，所有地方引用 | P2 |
| B4 | 迁移无注册表：19 个 `//go:embed` 变量手工排序，测试里又复制一份路径列表 | main.go:15-70、main.go:86；platform_test.go:62-77 | 改为 `//go:embed migrations/*.sql` 的 `embed.FS` 按文件名排序 | P2 |
| B5 | 死代码与恒真检查 | `nullableInt` 无调用（worker.go:52）；`channelFromRow` 永远返回 nil 错误但 6 处判错；`download` 的 `headers` 参数全部传 nil | 删除或收敛签名 | P3 |
| B6 | 时区与边界常量硬编码 | `FixedZone("CST")` admin.go:714、ops.go:89、wallet.go:135；`AT TIME ZONE 'Asia/Shanghai'` wallet.go:127；480s 超时 app.go:138、worker.go:233、worker.go:827；画布历史上限 20 content.go:328 | 集中到 `Config`，SQL 用参数传时区 | P3 |

### 性能与数据库

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| B7 | 热路径缺索引 | `request_logs(task_id)`：worker.go:438/770/800 每次尝试与结算按 task_id 查；`upstream_cost_entries(task_id)`：worker.go:763、costs.go:205；`upstream_cost_entries(channel_id)`：admin.go:520 每个渠道 percentile 全表扫；`generation_tasks(finished_at)`：public_status.go:30/38 每次状态页；`generation_tasks(output_media_id)`、`assets(media_id)`：media.go:409、worker.go:841 清理逐行 NOT EXISTS。migrations 中均无对应索引 | 新增迁移补齐上述 6 个索引 | P1 |
| B8 | 空闲轮询开销固定：20 个 worker 各自每 2.5s 一次 `SKIP LOCKED` 约 8 qps 空转；SSE 每订阅者每 2.5s 跑两条查询；连接池默认 20 等于 worker 数 | worker.go:228-249；text_stream.go:110-149；app.go:113 | worker 领取失败指数退避或 `LISTEN/NOTIFY`；SSE 心跳不查库，收到 changed 才查；`DB_MAX_CONNS` 默认大于 worker 数 | P2 |
| B9 | 文本对话 N+1：每条历史消息调用 `references()`，每个附件再查一次 DB 与一次 S3，且全部历史图片每轮重新 base64 上送 | upstream.go:398、upstream.go:213-227；`promptEstimate` 用 `octet_length/4` 粗估（pricing.go:95） | 一次查询取整个会话附件；对历史附件做数量与字节上限 | P2 |
| B10 | 分页与聚合无上限：全部 offset 分页 + 每次 `count(*)`；`/admin/users`、`/canvas-projects`、画布历史无分页；`/admin/stats` 一次 8 条聚合含两次 `percentile_cont`，无时间范围时扫全表 | app.go:391-404；admin.go:73；content.go:112、233；admin.go:855-887 | keyset 分页；stats 强制时间范围或缓存 | P2 |
| B11 | HTTP 服务端超时不完整：只有 `ReadHeaderTimeout`，无 `IdleTimeout`，50MB 上传无期限 | main.go:91；media.go:347 | 设 `IdleTimeout`；非 SSE 路由加 context 超时 | P2 |
| B12 | 媒体全部经 Go 进程代理转发 | media.go:381-393 `GetObject` + `ServeContent` | 鉴权后返回短期 MinIO 预签名 URL 或 Nginx `X-Accel-Redirect` | P2 |
| B13 | 存储膨胀：文本任务结算后 `partial_text` 不清空，与 `messages.content` 双份；cleanup 只在进程启动 24h 后首次运行，频繁重启的容器永远不清理 | worker.go:760；worker.go:280-292 | 结算后清空 `partial_text`；启动即跑一次 cleanup 并加分布式锁 | P3 |

### 安全

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| B14 | 多个写接口无频控：兑换码、媒体上传、报价、画布保存、创建对话 | groups.go:74；media.go:337（组配额默认 0 = 不限，ops.go:41）；pricing.go:99；content.go:124；text.go:67。已核对 `a.rate` 全部调用点 | 加 per-user/per-IP 频控；未分组用户给平台级默认存储配额 | P2 |
| B15 | 管理员只有单一角色，无权限粒度，无高危操作二次验证 | app.go:550-556 仅判 `Role != "admin"`；任一管理员可改支付商户配置、重置任意密码、调余额、清空日志 | 拆运营/财务/超级管理员，或高危操作复用 `verifySecurityProof` 做 TOTP 二次验证 | P2 |
| B16 | 管理审计覆盖不全，部分审计在事务外 | 无审计：模型状态 PATCH（admin.go:319-350）、模型删除、绑定增删、日志清空；敏感词审计用 `a.DB` 在写操作后单独执行（groups.go:345/360） | 中间件统一记录 admin 组所有非 GET 请求；业务内审计放同一事务 | P2 |
| B17 | 加密密钥不可轮换：`sha256(EncryptionKey)` 直接派生，密文无版本前缀；渠道 Key、支付配置、SMTP、TOTP、订单快照全依赖同一密钥 | app.go:406-441 | 密文加 key-id 前缀，支持多版本解密与后台重加密 | P2 |
| B18 | 用户取消任务不传播到上游，仍会产生成本 | `cancelTask` 只更新 DB（generation.go:378-413）；图片/视频/音频请求跑到结束后才在 `finishTask` 丢弃（worker.go:663） | worker 持有每任务 cancel func，通过 Redis Pub/Sub 广播取消 | P2 |
| B19 | 密码只校验长度 10-128；会话固定 7 天无滑动过期 | auth.go:273、security.go:227；auth.go:105 | 增加弱密码检查；`/auth/me` 命中时续期 | P3 |

### 可观测性与运维

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| B20 | 整个后端仅 7 处 `slog` 调用；500 错误只记 path 与错误类型不记 message；无请求 ID、无 `/metrics`、无 pprof、无请求日志中间件 | app.go:480 | 加请求 ID 中间件；500 记录脱敏后的 err（`upstreamTrace.redact` 可复用）；暴露 Prometheus 指标（队列深度、最老排队时长、渠道成功率） | P1 |
| B21 | worker 路径大量吞错：`_ = a.finishTask(...)` 多处；`requeue` 忽略 Exec 错误；`recoverTasks` 出错 continue 不记日志 | worker.go:580/582、791/805、239 | 所有 `_ =` 至少 `slog.Warn` 带 task/err | P1 |
| B22 | 滚动重启会把执行中任务判为失败并退款而非重排；`Shutdown` 无期限 | ctx 取消 → `classify` 为 canceled（worker.go:131-133）→ 非 resuming 不重排（454-461）→ failed 退款（570-573）；main.go:95 | SIGTERM 后停止领取并给在途任务宽限；超时未完成的重排 | P2 |
| B23 | 健康检查不区分 liveness/readiness，无停滞告警信号 | app.go:524-537；ops.go:126 | 加 `/ready`；status 增加最老 queued 等待秒数与 running 超期数 | P3 |

### 测试

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| B24 | CI 实际只跑约 7 个纯函数测试，其余 37 个全部 Skip | `backend-ci.yml` 无 services 与 `TEST_DATABASE_URL`；platform_test.go:34-36 无 DSN 即 `t.Skip` | CI 加 postgres/redis/minio services；把 SKIP 数量超阈值视为失败 | P1 |
| B25 | 明显未覆盖模块：画布项目/历史、素材 CRUD、支付订单与三家 provider 客户端、`/admin/stats`、会话撤销；无 Benchmark、无 fuzz | 按关键词全量 grep `*_test.go` | 支付 provider 用 httptest 假网关补全流程；解析器加 `FuzzXxx` | P2 |
| B26 | 测试绕过 `New()`，配置校验与迁移执行器几乎无覆盖 | platform_test.go:62-78 手工执行 SQL | 迁移测试改为调用 `runMigrations` | P3 |

## 二、前端（web/）

### 代码结构

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| W1 | `pages/canvas/project.tsx` 3783 行，单组件混合 6 类职责 | 一个函数内 47 处 `useState`、18 处 `useEffect`、96 处 `useCallback`；`handleGenerateNode` 一个 useCallback 约 550 行（:2485-3041）；两个 1.8s `setInterval` 轮询恢复（:660、:728） | 按 AGENTS.md 约定拆分：节点/连线/选区进 `stores/canvas`；轮询恢复、快捷键、剪贴板拆为 `pages/canvas/hooks/`；生成编排按模式拆到 `lib/canvas/` | P1 |
| W2 | `CanvasNode` 接收 40+ 个 props，与 AGENTS.md「避免一个组件传递过多参数」冲突，且派生值每次渲染都是新对象削弱 memo | project.tsx:3526-3566；canvas-node.tsx:30-86 | 节点内部按 `node.id` 从 store 订阅派生态；回调改为稳定 actions | P1 |
| W3 | `pages/image` 与 `pages/video` 存在整段相同代码 | `LogPanel`、`moveListItem`、`ReferenceOrderButtons` 三个函数字节相同（image:769 / video:647）；`LogCard`、`summaryToLog`、`taskToResult`、初始化 effect 同形 | 抽到 `components/generation/` 与 `lib/generation-log.ts` | P1 |
| W4 | 开源版「浏览器直连上游」子系统约 3600 行仍完整保留，与 AGENTS.md「密钥不下发浏览器」矛盾 | `services/api/model-plugin.ts`(993 行) 含 `Bearer ${apiKey}`；`image.ts:757-822 requestDirectEdit` 直连 `/images/edits`，全仓库无调用；`app-sync.ts`、`webdav-sync.ts`、`local-proxy.ts`、`config-local-proxy.tsx`、`channel-editor-drawer.tsx`、`model-script-editor.tsx` 等 | 整体删除；`image.ts` 只保留 `requestPlatformImages` 路径 | P1 |
| W5 | `AppConfigModal` 从未被挂载，`openConfigDialog` 是空操作，用户点了只看到 warning | `<AppConfigModal` 无任何渲染点；project.tsx:360/410/3034/3230、canvas-config-node-panel.tsx:84 仍调用 | 删除相关状态与调用点，模型未就绪统一提示联系管理员 | P1 |
| W6 | 死路由页面与凭据导入残留 | `pages/studio/index.tsx`、`pages/config/index.tsx` 无 import（router 已重定向）；`client-root-init.tsx:19-36` 仍从 URL 读 `?baseUrl=&apiKey=`；`canvas-proxy/` 整个目录已无用 | 删除 | P2 |
| W7 | `local-agent-panel.tsx` 单组件 1380 行 | :127-1511 | clientId 管理、事件归属抽到 `lib/agent/`；连接/审批/历史合并拆 hook | P2 |
| W8 | 未使用依赖 | `@ant-design/pro-components`、`shadcn`、`class-variance-authority`、`@codemirror/lang-json` 在 src 内 0 处 import | 清理 | P3 |

### 状态与数据层

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| W9 | `use-config-store.ts` 573 行中大量字段为开源版遗留，运行时被 `platformConfig()` 强制覆盖 | `AiConfig` 含 `channelMode/baseUrl/apiKey/proxyUrl`、`WebdavSyncConfig`（:32-70）；`platformConfig()` :219-241 覆盖为单渠道空 Key；`isAiConfigReady` 仍检查 `apiKey.trim()` 逻辑已失真 | 重设计为只含模型选择与生成参数；删除按名猜能力的 `guessCapability` 等（后端已下发 capability） | P1 |
| W10 | 提示词源仍从浏览器直接 `fetch` 外部 URL，且有全局定时器，但配置入口在从未挂载的弹窗内 | prompt-source-runtime.ts:26；use-prompt-source-scheduler.ts:37 | 改为后端接口，或删除整套 prompt-source | P2 |
| W11 | 数据获取不统一：后台全部 `useQuery`，用户侧 6 个页面仍手写 `useEffect+useState` | user/logs:24-59 用 10 个 useState 管分页；user/stats:12-27 | 迁到 `useQuery`，与 admin/logs 共享 queryKey 约定 | P2 |
| W12 | `getPublicModels()` 至少 6 处独立调用，全部绕过 react-query 缓存 | user-layout.tsx:29、image:127、video:116、text:10、image.ts:1013、audio.ts:13、video.ts:23 | 提供 `usePublicModels()` 单入口 | P2 |
| W13 | 画布任务恢复用两段 `setInterval` 每 tick 遍历全部 nodes，依赖数组含 `nodes` 导致任何节点变化都重建定时器 | project.tsx:660、:728；`use-generation-batches.ts:60` 又一份 | 统一为 react-query `refetchInterval` 或后端 SSE，只对 pending 节点订阅 | P2 |

### 性能

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| W14 | 入口 chunk 1.35 MB（未 gzip），无 `manualChunks` | `dist/assets/index-*.js` 1,350,479 B；`mermaid-*.js` 506 KB 来自 streamdown；vite.config.ts 无 manualChunks | 拆 `react-vendor`、`antd`、`icons`、`query`；确认 mermaid 只在渲染时动态加载；用 visualizer 定位 | P1 |
| W15 | 无列表虚拟化；素材页整表 hydrate 后在内存切片分页 | package.json 无 react-window/react-virtual；assets/index.tsx:73-75 | 素材改服务端分页；长列表引入 `@tanstack/react-virtual` | P2 |
| W16 | 画布拖动时 7 个依赖 `nodes` 的 `useMemo` 全部重算，再经 props 传播到所有节点 | project.tsx:977-1034 | 拖动期间只更新 position slice，派生数据下沉到 store selector | P2 |
| W17 | `tsconfig` `target: ES2018` 导致 `??`、`?.` 等被降级 | tsconfig.json:3 | 改为 ES2022 | P3 |

### 质量与测试

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| W18 | 无 ESLint，5 处 `eslint-disable-next-line react-hooks/exhaustive-deps` 实际不生效 | package.json 无 eslint；project.tsx:520、image:159/285、video:159/318 | 加 eslint + typescript-eslint + react-hooks，进 build 前置 | P1 |
| W19 | 测试仅 8 个 node:test 文件，手工 transpile 加载源码；`tests/image-thumbnail.test.ts` 用 `bun:test` 且不在 `*.test.cjs` 匹配范围，从未运行；无组件测试、无 e2e | tests/、package.json `test` 脚本 | 引入 vitest；关键路径（登录、文本对话、生图、画布保存）加 Playwright | P1 |
| W20 | `strict: true` 但缺 `noUnusedLocals/noUnusedParameters`，死代码因此残留 | tsconfig.json | 开启两项 flag | P2 |
| W21 | 全局无 ErrorBoundary，路由无 `errorElement`，发版后旧 chunk 404 会白屏 | grep 为空 | router 各层加 `errorElement`；AppProviders 包 ErrorBoundary | P2 |
| W22 | i18n 双轨：后台 643 行含中文、0 处 `t()`；画布组件 407 处 `t()`；en-US 用户看到半中半英 | rg 统计 | 二选一：平台只做中文则移除 i18next（省约 150 KB）；或补齐后台 key | P2 |

### UX

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| W23 | 画布无移动端/触屏适配也无提示 | project.tsx 无响应式类，全局事件只监听 mouse/pointer | 窄屏给「建议桌面端使用」提示页；后续 Pointer Events 统一 | P2 |
| W24 | 快捷键已实现但 UI 无发现入口；后台 16 个页面仅 3 处 aria 属性 | project.tsx:1778-1841 | 工具栏加快捷键面板；可点击 div 改 button | P3 |
| W25 | 前端每次挂载向上游 GitHub 拉版本号，fork 场景无意义且大陆环境常不可达；整份 CHANGELOG 打进主包约 63 KB | use-version-check.ts:7-8；vite.config.ts:56 `__APP_RELEASES__` | 改为后端 `/api/version`；只内嵌最近 3 个版本 | P3 |

## 三、部署、CI 与仓库

| # | 问题 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| D1 | 没有任何 PostgreSQL / MinIO / Redis 备份机制；`CHANNEL_ENCRYPTION_KEY` 丢失即全部渠道密钥作废 | docker-compose.yml:102-105 只声明卷；全仓库无 pg_dump/mc mirror 脚本 | 加每日 pg_dump sidecar + mc mirror 异地；`.env` 纳入 off-site；写恢复 runbook | P1 |
| D2 | 迁移只能前进，启动即迁移，无升级前快照 | app.go:210-245；main.go:73-110 | 部署脚本升级前自动 pg_dump，失败则 restore | P1 |
| D3 | 前端与 canvas-agent 完全没有 CI | workflows 仅 backend-ci（限 `server/**`）与 publish-plugins | 新增 frontend-ci：typecheck + test + build；canvas-agent 同理 | P1 |
| D4 | 没有镜像构建发布，生产靠服务器现场 build，回滚只能 checkout 重编 | 910e7e5 删除了镜像 workflow；README:175-179 | tag 推送时 GHCR 构建 web/api 镜像，compose 改用 `image:` | P1 |
| D5 | 远程插件以同源特权执行任意 JS，清单无完整性校验，任何用户可输入 URL 安装；fork 默认 registry 指向上游仓库，本仓库 CI 产物根本没被用到 | plugin-loader.ts:11-23 Blob + `import()`；canvas-plugin-manager-modal.tsx:51；registry/build.mjs:54-68 无 integrity；env.ts:6 指向 `basketikun/infinite-canvas@plugins-dist`，publish-plugins.yml:47 推到 `${GITHUB_REPOSITORY}` | manifest 加 integrity 并校验；非官方 URL 安装仅 admin；Dockerfile 用 `VITE_PLUGIN_REGISTRY_URL` 指向本仓库；配合 CSP | P1 |
| D6 | docs 站点 overview 三篇仍描述「浏览器本地 API Key 直连」的开源版，与平台架构直接矛盾 | quick-start.zh-CN.mdx:12/41/48；features.zh-CN.mdx:15/60/168；render.zh-CN.mdx | 重写 quick-start 与 features；删除 render.mdx | P1 |
| D7 | nginx 容器无 healthcheck；compose 无资源限制与日志轮转 | docker-compose.yml:3-12 | 加 healthcheck、`logging` max-size、`mem_limit` | P2 |
| D8 | 静态站点缺安全响应头；Go 侧只给 `/api` 加了 3 个头；`client_max_body_size` 与 `MAX_UPLOAD_BYTES` 两处独立配置 | nginx.conf 无 X-Frame-Options/CSP；app.go:490-492；nginx.conf:41 | nginx server 级补齐；CSP 先 Report-Only | P2 |
| D9 | web 与 canvas-agent 各有两份漂移的锁文件；Dockerfile 用 npm，vercel.json 用 bun | web/bun.lock 与 package-lock.json 版本不一致 | 统一为 npm，删另一份锁 | P2 |
| D10 | 无 Dependabot、无 govulncheck、无 npm audit、无 trivy | .github 无 dependabot.yml；backend-ci 只有 vet/test/build | 加 Dependabot 四类；backend-ci 加 govulncheck | P2 |
| D11 | 发版节奏失控：Unreleased 积压 41 条；官方插件只在 tag 时发布 | CHANGELOG.md:3-49；publish-plugins.yml:7-8 | 加 release.yml 校验 VERSION == tag 并生成 Release notes；约定切版本周期 | P2 |
| D12 | `canvas-proxy/`、`api/`（旧 Node 版）无 CI 无部署引用，只作参考 | git ls-files 确认仍跟踪 | 打 tag 后从 main 删除或移到 archive/ | P2 |
| D13 | 环境变量漂移：`WORKER_CONCURRENCY` 三处默认值不一致（50/20/20）且可能超过 `DB_MAX_CONNS`；`ANALYTICS_*` 在 compose 下实际不生效；`LISTEN_ADDRESS` 未文档化；`IMAGE_WORKER_CONCURRENCY` 旧别名与 AGENTS.md「不写旧兼容」冲突 | .env.example:37、compose:39、app.go:118-122；docker-entrypoint.sh:14-15 | 统一示例值；启动时校验 `DB_MAX_CONNS >= WORKER_CONCURRENCY + N`；compose app 加 ANALYTICS 透传；移除旧别名 | P2 |
| D14 | 没有 OpenAPI / API 参考文档；REST 命名不一致；CORS 允许 `Idempotency-Key` 头但后端从不读取 | 全仓库无 openapi/swagger；generation.go:294/301 路径风格不一；app.go:510 | 手写 `docs/openapi.yaml`；统一资源命名；删除或实现幂等头 | P2 |
| D15 | README 外层反代 `proxy_read_timeout 300s` 小于内层 600s 与 Go 480s，长任务与文本流会在外层先断；`listen 443 ssl http2` 为弃用写法；配置表缺 `CORS_ORIGIN`、`COOKIE_SECURE`、`DB_MAX_CONNS` | README.md:157/170/187-197 | 统一为 ≥600s；改 `http2 on;`；补齐配置表 | P3 |
| D16 | render.yaml / vercel.json 只部署纯前端，与 Go 平台架构不符会误导部署 | render.yaml:4-10 | 删除或注明「仅静态演示」 | P3 |
| D17 | canvas-agent 与 Codex 强绑定；Claude 适配器把整段 prompt 作为 argv 且 win32 下 `shell: true`，有元字符注入与 8191 字符命令行上限问题 | canvas-agent/package.json:22；agent/claude.ts:12/51 | 短期改 stdin 传 prompt 并去掉 shell；中期抽 `AgentProvider` 接口，按 TODO 升级为 Claude Agent SDK | P2 |

## 四、可扩展功能

已核实当前 UI、路由或后端中不存在。

| # | 功能 | 现状 | 建议 | 优先级 |
|---|---|---|---|---|
| F1 | 对外 API Key / OpenAI 兼容网关 | 全部鉴权走 Cookie（auth.go:108-134）；`/user/account` 无 Key 管理；TODO 已列为待定 | 增加 `api_keys` 表（hash 存储、按用户/分组限额），`Bearer` 中间件与 `authenticate()` 并行；先只开放 `/v1/chat/completions` 与 `/v1/images/generations`；用量复用 `/user/logs` | P2 |
| F2 | 第三方登录（GitHub / 微信扫码 / OIDC） | `pages/login` 仅账号密码 + 邀请码 + MFA；grep oauth 为空 | 后端加 OAuth 回调，绑定已有账号或按邀请策略注册 | P2 |
| F3 | 画布/图片只读分享链接 | canvas-projects.ts 无 share 接口；grep shareToken 为空 | 后端签名 token + `/s/:token` 无登录路由；素材可选公开 | P2 |
| F4 | 模板/示例画布库 | 无 templates 页面或接口 | `/canvas` 列表加「从模板创建」；管理员维护模板，复用 `canvas-export.ts` 格式 | P2 |
| F5 | 上游协议能力扩展 | 文本无工具调用/JSON 模式/结构化输出，不透传思考内容（text_stream.go:211 过滤 `thought`）；图片无 mask 局部重绘、无 variations；音频仅 TTS 无 STT；无 embeddings；视频仅 openai-video 与 gemini-video 两个适配器 | 按价值排：mask 重绘与 STT 对创作平台最高；工具调用需新消息存储结构单独立项；即梦/可灵/Vidu/Sora 待供应商文档 | P2 |
| F6 | 任务完成推送与 webhook | 只有文本有 SSE（text.go:66）；图片/视频/音频靠轮询 `/generation-tasks/:id` | 复用 `streamSinks` 给批次加 SSE；对外 API 配 HMAC 签名 webhook | P3 |
| F7 | 重试退避与 429 处理 | `retryTask` 立即 `available_at=now()`（worker.go:593）；429 直接让整个渠道冷却，不读 `Retry-After`（channel_health.go:18） | 重试加 jitter；429 优先换 Key 并尊重 `Retry-After` | P3 |
| F8 | 模型参数 JSON Schema | 只有文本 config 做校验（admin.go:288-292），图片/视频/音频靠白名单 | 为各能力定义 schema 并下发前端生成表单 | P3 |
| F9 | 通知偏好设置 | notification-center.tsx 只做列表与已读 | `/user/account` 加任务完成/余额不足/公告的邮件与站内开关 | P3 |
| F10 | 跨画布搜索与素材批量操作 | `/canvas` 列表无搜索；素材页无多选 | PG `tsvector` 搜索标题与节点文本；素材多选删除与打标签 | P3 |
| F11 | 团队 / 工作区共享 | 所有资源按 owner 单用户隔离 | 在 F3 分享基础上加 workspace 表与成员角色 | P3 |
| F12 | PWA 壳 | public/ 无 manifest.json，无 service worker | `vite-plugin-pwa` 预缓存静态资源 | P3 |
| F13 | Agent 生态：MCP 只做 stdio 转发，skills store 未对外 | canvas-agent/src/server/mcp.ts:10-15；skills/store.ts | 加 Streamable HTTP MCP transport 供 Claude Desktop / Cursor 接入；skills 暴露安装 API | P3 |
| F14 | 文档与路由不一致 | docs/public-platform.md:25/28 描述 `/studio` 与 `/user/referrals`，前者已重定向，后者不存在 | 更新文档或补页面 | P3 |

## 五、建议处理顺序

1. **先止血（P1，运维与安全）**：D1 备份、D2 升级前快照、D5 插件完整性与 registry 指向、B24 让 CI 真正跑测试、D3 前端 CI、D4 镜像发布。
2. **再补可观测（P1，后端）**：B20 请求 ID 与错误日志、B21 worker 吞错、B7 热路径索引。
3. **然后清理技术债（P1，前端）**：W4 + W5 + W9 删除浏览器直连子系统并重建 config store（一起做，约减 4000 行）、W1 + W2 拆 project.tsx、W3 image/video 去重、W14 manualChunks、W18 ESLint、W19 vitest。
4. **P2 按迭代排**：B3 渠道可用 SQL 统一、B14 频控、B15 管理员分级、B18 取消传播、W11–W13 数据层统一、D6 文档重写、D13 环境变量对齐。
5. **功能扩展**：F1 对外 API Key 与 F3 分享链接价值最高且改动边界清晰，建议优先；F5 中 mask 重绘与 STT 次之。
