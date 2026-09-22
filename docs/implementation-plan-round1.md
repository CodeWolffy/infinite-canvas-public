# 第一轮改进实施文档（后端 + 前端）

本文档是给执行模型的操作手册。范围为 [improvement-review.md](improvement-review.md) 中「一、后端」「二、前端」两部分，以及「三、部署、CI 与仓库」里的仓库清理项（D9、D12、D16 与 D7 的 `.dockerignore` 部分）。「三」的其余项与「四、可扩展功能」本轮不做，见第 5 节。执行完成后由审查者按第 8 节的交付物逐项检查。

批次编号说明：任务分 A（前端死代码与仓库清理）、C（后端）、D（前端）、E（文档同步）四个批次。原 B 批次以及原 E1、E2 属于部署与 CI 范围，已整体移出，编号不再复用。

---

## 0. 执行规则（必须遵守）

1. **先读 `AGENTS.md`**，本轮所有改动都要符合其中的前端规范、后端规范和文档规范。
2. **分支**：从 `main` 新建分支 `improvement/round-1`，所有工作在该分支上进行。不要直接改 `main`。
3. **提交粒度**：每完成一个任务编号（如 `A1`、`C3`）提交一次，提交信息格式：`<type>(<scope>): <任务编号> <一句话中文说明>`，例如 `refactor(web): A1 删除浏览器直连上游子系统`。type 取 `feat/fix/refactor/perf/chore/docs/test`。
4. **验证是本轮的强制要求**（这是对 `AGENTS.md`「不需要执行构建」的一次性例外，因为本轮改动量大且由审查者复核）。每个任务完成后必须执行对应目录的检查并把结果记入报告：
   - 前端：在 `web/` 执行 `npm run typecheck` 与 `npm test`；涉及打包的任务再执行 `npm run build`。
   - 后端：在 `server/` 执行 `go vet ./...` 与 `go build ./...`。涉及数据库行为的任务（C1、C4–C8、C11、C13–C15、C17）还必须在设置了 `TEST_DATABASE_URL`（以及 `TEST_REDIS_ADDR`、`TEST_MINIO_ADDR`，变量名以 `platform_test.go` 为准）的环境下执行 `go test -count=1 ./...`。确实没有数据库时，在报告中逐任务标注「未跑数据库测试」，审查者会自行运行。
   - 检查不通过不得提交，先修到通过。
5. **不要动的东西**：`new-api/` 目录；`server/migrations/001` 到 `019` 的已有迁移文件；钱包、结算、退款、价格快照的业务逻辑（`wallet.go`、`pricing.go`、`finishTask` 内的金额计算）；`.github/workflows/*`、`Dockerfile`、`server/Dockerfile`、`nginx.conf`（部署与 CI 范围，本轮不做）；`AGENTS.md` 只允许追加规则不允许删改，唯一例外是 A2 第 1 条指明的那半句。
6. **不要顺手重构**任务范围之外的代码。发现范围外的问题写进报告的「发现但未处理」一节。
7. **文档同步**：每个任务完成后按 `AGENTS.md` 文档规范在 `CHANGELOG.md` 的 `Unreleased` 追加一条（内部重构可不记），在 `docs/content/docs/progress/pending-test.mdx` 与 `pending-test.zh-CN.mdx` 追加验收点。不要自行切版本号。
8. **遇到本文档与代码实际情况不符**（行号漂移、函数已改名等）以代码为准，按任务目标完成，并在报告中注明差异。
9. **遇到需要决策的问题**：不要停下来等待，按本文档给出的默认值执行，并在报告「待确认决策」一节列出。
10. **执行顺序**：按第 7 节的顺序表执行。批次内无依赖的任务顺序随意。
11. **新增环境变量的落点**：C 批次新增的每个环境变量必须同时出现在四处：`server/internal/platform/app.go`（读取与校验）、`.env.example`（注释掉的示例行）、`docker-compose.yml` 与 `docker-compose.local.yml` 的 `api` 服务 `environment`（`KEY: ${KEY:-默认值}` 形式）、`README.md`「关键配置说明」表。这是本轮唯一允许改动 compose 文件与 README 的情形。

---

## 1. 批次 A：前端死代码与仓库清理（先做，为后续任务减负）

### A1 删除「浏览器直连上游」子系统并重写配置 store

对应审查项 W4、W5、W6、W8、W9。

**背景**：平台版所有 AI 调用都经 Go 后端，`use-config-store.ts` 里的 `channels/apiKey/baseUrl/proxy/webdav` 字段与整套配置弹窗、本地代理、WebDAV、模型脚本编辑器已经无法从任何路由到达，但仍占约 3600 行代码并打进 bundle。

**要删除的文件**（删除前用 `grep -rn "<文件名不含扩展名>" web/src` 确认无其他引用；有引用的先改引用再删）：

```
web/src/services/api/model-plugin.ts
web/src/services/app-sync.ts
web/src/services/webdav-sync.ts
web/src/services/config-file.ts
web/src/services/api/local-proxy.ts
web/src/services/local-storage-usage.ts
web/src/components/layout/app-config-modal.tsx
web/src/components/layout/config-local-proxy.tsx
web/src/components/layout/config-local-storage.tsx
web/src/components/layout/config-prompt-sources.tsx
web/src/components/layout/prompt-source-editor-drawer.tsx
web/src/components/layout/prompt-source-content-modal.tsx
web/src/components/layout/channel-editor-drawer.tsx
web/src/components/layout/model-script-editor.tsx
web/src/components/layout/model-select-modal.tsx
web/src/pages/config/index.tsx
web/src/pages/studio/index.tsx
```

注意：`prompt-source-runtime.ts`、`prompt-source-presets.ts`、`use-prompt-source-store.ts`、`use-prompt-source-scheduler.ts` **保留**，因为 `/prompts` 页面与画布侧栏的提示词库仍依赖它们（迁移到后端属于功能扩展，不在本轮）。只删除上面列出的三个配置 UI 文件。`canvas-proxy/` 目录本身在 A2 中删除，A1 只删前端对它的引用。

**`web/src/services/api/image.ts` 瘦身**：
- 删除 `requestDirectEdit`、`fetchImageModels`、`fetchChannelModels`、`resolvePlatformImageModelId`、`aiApiUrl`、`aiHeaders`、`geminiBaseUrl`、`geminiModelName`、`geminiApiUrl`、`geminiHeaders`、`defaultGeminiConfig`、所有 Responses API 工具调用相关类型与函数（`ResponseToolCall`、`ResponseInputMessage`、`ToolResponseResult`、`toResponseInput` 等）以及 `runModelPlugin` 的引用。
- 保留并确保可用：`AiTextMessage` 类型、`requestGeneration`、`requestEdit`、`requestImageQuestion`、`requestPlatformImages`、`platformImageParameters`、`ensureReferenceMedia`、`resolvePlatformModelId`、错误读取函数（`readAxiosError` 等，若仍被保留函数使用）。
- 目标：该文件缩到 400 行以内。

**`web/src/stores/use-config-store.ts` 重写**（保持对外函数名，缩小内部结构）：
- `AiConfig` 删除字段：`channelMode`、`baseUrl`、`apiKey`、`apiFormat`、`channels`、`proxyEnabled`、`proxyUrl`。新增字段 `platformModels: ChannelModel[]`（由 `PublicModel` 映射，`name` 取模型 UUID，其余字段沿用）。保留所有生成参数字段（`imageModel`、`textModel`、`quality`、`size`、`videoSeconds` 等）。
- 删除类型 `ModelChannel`、`WebdavSyncConfig`、`ConfigTabKey`、`ChannelCredentialsImportResult`、`ApiCallFormat`；删除常量 `LOCAL_PROXY_PACKAGE`、`DEFAULT_LOCAL_PROXY_URL`、`OPENAI_BASE_URL`、`GEMINI_BASE_URL`。
- 删除 store 字段与动作：`webdav`、`isConfigOpen`、`configTab`、`shouldPromptContinue`、`importChannelCredentials`、`updateWebdavConfig`、`openConfigDialog`、`setConfigDialogOpen`、`clearPromptContinue`、`isAiConfigReady`。
- 删除函数：`guessCapability`、`createModelChannel`、`upsertChannelCredentials`、`normalizeChannelModels`、`modelOptionsFromChannels`、`resolveModelChannel`、`resolveModelRequestConfig`、`resolveModelScript`、`buildApiUrl`、`withLocalProxy`、`normalizeLocalProxyUrl`、`defaultBaseUrlForApiFormat`、`normalizeChannels`、`useEffectiveConfig`、以及 `isHttpBaseUrl`、`normalizedBaseUrlKey`、`normalizeImportedBaseUrl`、`stripTrailingApiVersion`、`importedChannelName`。
- **保留函数名与签名**（内部改为基于 `config.platformModels` 实现）：`encodeChannelModel`、`decodeChannelModel`、`isChannelModelValue`、`modelOptionName`、`modelOptionLabel`、`modelOptionPrice`、`findChannelModel`（返回类型改为 `{ model: ChannelModel } | null`）、`modelCapabilityOf`、`modelMatchesCapability`、`resolveModelForCapability`、`selectableModelsByCapability`、`normalizeModelOptionValue`（第二参数改为 `ChannelModel[]`）、`boolConfig`、`hydratePlatformModels`、`updateConfig`。
- 模型值编码 **必须保持** `platform::<uuid>` 格式（`PLATFORM_CHANNEL_ID = "platform"`），因为画布快照里已保存这种格式。
- 新增 `hasPlatformModel(config: AiConfig, model: string): boolean`，用于替代所有 `isAiConfigReady(config, model)` 调用。
- `defaultConfig` 里所有 `default::gpt-image-2` 之类的默认模型值改为空字符串。
- `persist` 的 `partialize`/`merge` 删除 `proxyEnabled`、`proxyUrl`、`webdav`、`isConfigOpen`、`shouldPromptContinue`。

**改引用**（每处都要处理）：
- `web/src/components/layout/client-root-init.tsx`：删除 `importChannelCredentials`、`openConfigDialog` 与 `?baseUrl=&apiKey=` 导入逻辑；只保留 `usePromptSourceScheduler()` 与 `children`。
- `web/src/pages/canvas/project.tsx`：删除 `openConfigDialog`、`isAiConfigReady`、`useEffectiveConfig` 的使用；`effectiveConfig` 改为 `config`；`isAiConfigReady(x, m)` 改为 `hasPlatformModel(x, m)`；原本调用 `openConfigDialog(true)` 的地方改为 `message.warning("平台模型渠道未就绪，请联系管理员配置渠道")` 后 `return`。
- `web/src/pages/canvas/hooks/use-plugin-host.tsx`：参数 `isAiConfigReady` 改为直接 import `hasPlatformModel`。
- `web/src/components/canvas/canvas-config-node-panel.tsx`：删除 `openConfigDialog`，`ModelPicker` 的 `onMissingConfig` 改为提示文案；`useEffectiveConfig()` 改为 `useConfigStore((s) => s.config)`。
- `web/src/components/model-picker.tsx`：删除 `config.channelMode === "local"` 分支。
- `web/src/pages/image/index.tsx`、`web/src/pages/video/index.tsx`：`useEffectiveConfig()` 改为 `useConfigStore((s) => s.config)`。
- `web/src/lib/agent/agent-site-tools.ts`：确认仍编译通过。
- `web/src/router.tsx`：`/studio`、`/config` 的重定向条目保留（用户书签兼容），但删除对已删页面的任何 import。
- i18n：删除 `zh-CN.ts`、`en-US.ts` 中只被已删组件使用的键（`config.*` 下与渠道、代理、WebDAV、本地存储、脚本编辑相关的键）。方法：对每个 `config.xxx` 键 grep `web/src`，无引用则删。
- 依赖：从 `web/package.json` 删除 `@ant-design/pro-components`、`shadcn`、`class-variance-authority`、`@codemirror/lang-json`、`@codemirror/lang-javascript`、`@uiw/react-codemirror`（删除前逐个 grep 确认 `src/` 无 import；`shadcn` 若只有 CSS import 也删，并删除对应 import 行）。删除后运行 `npm install` 更新 `package-lock.json`（`web/bun.lock` 在 A2 中删除，不要用 bun 安装）。根 `Dockerfile` 中的 `--legacy-peer-deps` 与注释本轮不改。

**验收**：
- `npm run typecheck`、`npm test`、`npm run build` 通过。
- `grep -rn "apiKey\|Bearer \|x-goog-api-key" web/src --include=*.ts --include=*.tsx` 只剩管理后台渠道页面对后端 API 的字段名引用，不存在浏览器直连上游的请求代码。
- `grep -rn "openConfigDialog\|isAiConfigReady\|useEffectiveConfig\|channelMode\|withLocalProxy" web/src` 为空。
- 登录后画布、生图工作台、视频创作台、文本对话页可正常选择模型并发起一次生成（本地 Docker 或 dev server + 后端）。

### A2 仓库清理

对应审查项 D9、D12、D16 与 D7 的 `.dockerignore` 部分。全部是删文件和改句子，不涉及运行时行为。以下行号已核对，若有漂移以内容为准。

1. **归档并删除旧 Node 版接口 `api/`**：先执行 `git tag legacy-node-api main` 留档（不推送也可以，报告里注明），再在工作分支执行 `git rm -r api`。然后把下面这些句子改为「旧 Node 版接口已归档在 `legacy-node-api` 标签，不再随仓库提供」：
   - `AGENTS.md:26` 结尾的「`api/` 仅保留为公司版接口参考，不再作为部署入口」。这是本轮唯一允许修改 `AGENTS.md` 既有内容的地方，只改这半句，其余一字不动。
   - `docs/index.md:3` 与 `docs/index.zh-CN.md:3` 的「原 `api/` 与企业版文档保留为参考」。
   - `docs/public-platform.md:3` 的「`api/` 保留为公司版接口参考，不参与 Docker 运行」。
   - `docs/content/docs/overview/docker.mdx:8` 与 `docker.zh-CN.mdx:8` 的「原 `api/` 不参与部署」。
   - `docs/enterprise-api-review.md`：不删除。在正文第一段前加一行「本文审查的 Node 版 API 已归档到 `legacy-node-api` 标签，文中 `api/` 路径以该标签为准。」
2. **删除 `canvas-proxy/`**：`git rm -r canvas-proxy`。README 与 docs 中没有对它的说明，无需改文档；前端引用已在 A1 删除。
3. **删除纯前端托管配置**：`git rm render.yaml vercel.json web/vercel.json docs/content/docs/overview/render.mdx docs/content/docs/overview/render.zh-CN.mdx`；从 `docs/content/docs/overview/meta.json:9` 与 `meta.zh-CN.json:9` 的 `pages` 数组移除 `"render"`；删除 `docs/index.md:9` 与 `docs/index.zh-CN.md:9` 的 Render 链接行。`docs/vercel.json` 是文档站自己的部署配置，保留。
4. **统一为 npm 锁文件**：`git rm web/bun.lock canvas-agent/bun.lock`。`docs/` 只有 `bun.lock`，保留；`plugins/` 各目录只有 `package-lock.json`，不动。同时把文档里针对 `web/` 与 `canvas-agent/` 的 bun 命令改为 npm（`bun install` → `npm install`，`bun run dev` → `npm run dev`）：`docs/content/docs/development/local-development.mdx`（第 14、15、24 行）、`local-development.zh-CN.mdx`（第 14、15、33 行）、`docs/content/docs/overview/quick-start.mdx`（第 19、20 行）、`quick-start.zh-CN.mdx`（第 20、21 行）、`docs/content/docs/overview/codex-app-plugin.zh-CN.mdx`（第 124、125 行，先看上下文，只有命令针对 `web/` 或 `canvas-agent/` 时才改）。文档站 `docs/` 自身的 bun 命令不改。quick-start 其余内容本轮不重写。
5. **`.dockerignore` 补齐**：删除 `api/node_modules`、`api/dist` 两行（目录已不存在）；把 `docs/.next`、`docs/.source`、`docs/node_modules`、`docs/out` 四行合并为一行 `docs`；追加 `web/dist`、`web/tsconfig.tsbuildinfo`、`canvas-agent`、`plugins`、`assets`、`.agents`、`skills-lock.json`。根 `Dockerfile` 只用到 `web/`、`VERSION`、`CHANGELOG.md`、`nginx.conf`，`server/Dockerfile` 只用到 `server/`，改后两者都不受影响。
6. **删除从未运行的重复测试**：`git rm web/tests/image-thumbnail.test.ts`（`bun:test` 版本；`.cjs` 版本保留，D1 迁移 vitest 时统一处理）。

**验收**：
- `git ls-files api canvas-proxy render.yaml vercel.json web/vercel.json web/bun.lock canvas-agent/bun.lock web/tests/image-thumbnail.test.ts` 输出为空。
- `grep -rn '`api/`' AGENTS.md README.md docs/*.md docs/content` 只剩指向 `legacy-node-api` 标签的句子（`web/src/services/api/` 这类路径不算）；`grep -rn '/overview/render\|"render"' docs/index*.md docs/content/docs/overview/meta*.json` 为空。
- `grep -rn "bun install\|bun run" docs/content/docs/development docs/content/docs/overview` 只剩针对文档站自身的命令（若有）。
- 在 `web/` 执行 `npm ci` 与 `npm run build` 通过，确认删除 `bun.lock` 后 npm 流程完整。
- 有 Docker 时 `docker build -t ic-web-test .` 与 `docker build -f server/Dockerfile -t ic-api-test .` 均成功；没有则在报告注明未验证。

---

## 2. 批次 C：后端

### C1 数据库索引与渠道可用视图（迁移 020）

对应 B7、B3。新建 `server/migrations/020_indexes_and_available_channels.sql`，在 `main.go` 与迁移列表末尾注册（C2 会把注册方式改为自动扫描，两者顺序无所谓，但最终结果必须是 020 在 019 之后执行）。内容：

```sql
CREATE INDEX IF NOT EXISTS request_logs_task_idx ON request_logs(task_id);
CREATE INDEX IF NOT EXISTS upstream_cost_task_idx ON upstream_cost_entries(task_id);
CREATE INDEX IF NOT EXISTS upstream_cost_channel_status_idx ON upstream_cost_entries(channel_id,status) INCLUDE(duration_ms);
CREATE INDEX IF NOT EXISTS generation_tasks_finished_idx ON generation_tasks(finished_at DESC);
CREATE INDEX IF NOT EXISTS generation_tasks_output_media_idx ON generation_tasks(output_media_id) WHERE output_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_media_idx ON assets(media_id) WHERE media_id IS NOT NULL;

CREATE OR REPLACE VIEW available_model_channels AS
SELECT b.id AS binding_id, b.model_id, b.channel_id, b.priority, b.weight, b.upstream_model, b.cost_config, c.capability, c.protocol, c.cooldown_until
FROM model_channels b
JOIN channels c ON c.id=b.channel_id
JOIN models m ON m.id=b.model_id
WHERE b.enabled AND c.status='active' AND c.deleted_at IS NULL AND c.auto_disabled_at IS NULL
  AND m.status='published' AND m.deleted_at IS NULL
  AND c.capability=m.capability AND (c.protocol<>'anthropic' OR m.capability='text')
  AND EXISTS(SELECT 1 FROM channel_keys k WHERE k.channel_id=c.id AND k.status='active');
```

写迁移前先核对各表列名（`assets.media_id`、`generation_tasks.output_media_id`、`model_channels` 的列）是否存在，以 `001`–`019` 迁移为准。

然后把以下 7 处「渠道可用」判定改为查询该视图（冷却与排除列表条件保留在各自查询里）：
- `content.go` `/api/models` 的 `EXISTS(...)`（这一处改完后行为修正：不再列出已自动停用或无可用 Key 的模型）。
- `generation.go` `modelForTask` 的 `available` 查询。
- `worker.go` `candidates`、无候选时的 `configured` 查询、`eligible` 两条、`retryTask` 的 `EXISTS`。
- `admin.go`、`public_status.go` 中若有同类判定也一并替换（grep `auto_disabled_at IS NULL` 找全）。

**验收**：`go test ./...` 通过；新增一个测试：渠道 `auto_disabled_at` 非空时 `/api/models` 不再返回该模型。

### C2 迁移文件自动注册

对应 B4。
- `server/main.go`：删除 19 个 `//go:embed` 变量，改为 `//go:embed migrations/*.sql` + `var migrationFS embed.FS`；新增函数 `loadMigrations(fs.FS) ([]string, error)` 读取目录、按文件名排序、返回内容切片；`platform.New` 的入参不变。
- `platform_test.go` 的 `testApp`：把手写文件列表改为 `os.ReadDir("../../migrations")` 排序后逐个执行（`001` 在前）。
- 验收：`go vet`、`go build`，测试通过；新增测试断言迁移数量等于目录文件数。

### C3 请求 ID、结构化日志、错误日志与 worker 吞错

对应 B20、B21、B23。

1. 新增 `server/internal/platform/observability.go`：
   - 中间件 `requestID()`：读 `X-Request-ID`（长度 ≤ 64 且只含 `[A-Za-z0-9-_]` 才采用，否则生成 uuid），写回响应头，放入 gin context 与 `slog` 属性。
   - `fail()`：500 日志改为 `slog.Error("请求处理失败", "requestId", id, "path", c.FullPath(), "method", ..., "userId", <若已登录>, "error", truncate(err.Error(), 500))`。**仍不记录请求体与参数**。
   - `LOG_LEVEL`（debug/info/warn/error，默认 info）与 `LOG_FORMAT`（text/json，默认 text）两个环境变量，在 `main.go` 里用 `slog.SetDefault(slog.New(handler))` 生效。按第 0 节规则 11 落到四处。
   - 访问日志：中间件在请求结束后 `slog.Info("http", "requestId", ..., "method", ..., "path", c.FullPath(), "status", ..., "durationMs", ..., "userId", ...)`；`/health`、`/ready`、`/metrics` 与 SSE 路由 `/api/text/requests/:id/events` 不记。
2. Prometheus 指标：引入 `github.com/prometheus/client_golang`（`go get`，提交 `go.mod`/`go.sum`）。新增环境变量 `METRICS_ADDRESS`（默认空 = 关闭）；非空时在该地址单独起一个 `http.Server`，挂 `/metrics` 与 `net/http/pprof`（`/debug/pprof/`）。指标：
   - `ic_http_requests_total{route,method,status}` counter、`ic_http_request_duration_seconds{route}` histogram。
   - `ic_tasks_queued`、`ic_tasks_running` gauge，`ic_tasks_oldest_queued_seconds` gauge，由一个每 10 秒运行的 goroutine 查询更新。
   - `ic_upstream_attempts_total{channel_id,category}` counter，在 `recordAttemptFailure` 与成功结算处递增。
   - 两份 compose 只透传该环境变量，不做 `ports` 映射；README 说明只在内网使用。
3. `worker.go` 吞错整理：所有 `_ = a.finishTask(...)` 改为 `if err := a.finishTask(...); err != nil { slog.Warn("任务结算失败", "task", task["id"], "error", err) }`；`requeue` 两处 `_, _ =` 改为记录 `slog.Warn("任务重排失败", ...)`；`recoverTasks` 中 `continue` 前记录 `slog.Warn("恢复任务失败", "task", ..., "error", err)`；第 239 行附近 `slog.Warn("暂时无法领取任务")` 补上 `"error", err`；`cleanup` 中的 `_, _ = a.DB.Exec` 逐条改为记录错误。可以写一个小 helper `logExec(ctx, name string, err error)` 减少重复。
4. 新增 `GET /ready`：`startedAt` 非零且 worker 已启动时返回 200，否则 503（不 ping 依赖；`/health` 保持原样）。`GET /api/admin/status` 返回增加 `oldestQueuedSeconds` 与 `overdueRunning`（`status='running' AND deadline<now()` 的数量）。

### C4 频控补齐

对应 B14。使用现有 `a.rate(c, key, limit, window)`，在以下 handler 入口处添加（key 前缀统一 `<用途>:user:<userID>`）：

| 接口 | 限额 |
|---|---|
| `POST /api/user/redeem`（groups.go） | 10 次/分钟/用户，另加 `redeem:ip:<hash(ip)>` 30 次/分钟 |
| `POST /api/media`（media.go） | 60 次/分钟/用户 |
| `POST /api/generation-quote`（pricing.go） | 120 次/分钟/用户 |
| `PUT /api/canvas-projects/:id`（content.go `saveProject`） | 120 次/分钟/用户 |
| `POST /api/text/conversations`（text.go） | 30 次/分钟/用户 |
| `POST /api/canvas-projects`（创建画布） | 30 次/分钟/用户 |

这些数值是默认值，写入报告「待确认决策」。返回 429 沿用 `a.rate` 现有格式。

### C5 管理操作审计中间件与事务内审计

对应 B16。
1. 在 `app.go` Router 的 `admin` 分组中间件之后增加一个中间件：`c.Next()` 之后，若 `c.Request.Method != GET` 且 `c.Writer.Status() < 400`，插入 `audit_logs(actor_id, action, target, detail)`：`action` = `"http." + method + " " + c.FullPath()`，`target` = `c.Param("id")` 或其他第一个路径参数（无则空串），`detail` = `{"query": c.Request.URL.RawQuery, "status": status, "requestId": ...}`。**不要记录请求体**。用 `a.DB` 写入，失败只 `slog.Warn`。
2. `groups.go` 敏感词新增/删除：把业务写入与 `a.audit` 放进同一个 `pgx.BeginFunc` 事务。
3. `admin.go` 模型删除、模型状态 PATCH、绑定增删：不需要再手工加 `a.audit`（中间件已覆盖）。

### C6 加密密钥可轮换

对应 B17。
- 密文格式：新密文写为 `v1:` + 现有 base64（`seal` 加前缀）。`unseal`：有 `v1:` 前缀时去前缀后用主密钥解；无前缀时按旧格式先用主密钥解，失败再用 `CHANNEL_ENCRYPTION_KEY_PREVIOUS`（新增可选环境变量，按规则 11 落四处）解。
- 新增子命令 `canvas-server rotate-keys`（`main.go` 中与 `health` 同样处理）：读取配置后，对所有加密列执行「unseal（旧）→ seal（新）」并 `UPDATE`。加密列清单通过 `grep -n "a.seal(" server/internal/platform/*.go` 找全（预期包括 `channel_keys` 的 key 密文、渠道快照 `generation_tasks.channel_snapshot`、支付渠道配置、支付订单快照、SMTP 密码、TOTP 密钥）。每张表在一个事务里分批（每批 500 行）处理，完成后打印各表更新行数。
- README「关键配置说明」补一段：轮换步骤 = 设 `CHANNEL_ENCRYPTION_KEY_PREVIOUS=<旧>`、`CHANNEL_ENCRYPTION_KEY=<新>` → 重启 → `docker compose exec api canvas-server rotate-keys` → 移除 PREVIOUS 再重启。
- 测试：新增 `TestSealVersionedRoundTrip`（v1 密文可解、无前缀旧密文用 PREVIOUS 可解）。

### C7 任务取消传播到上游

对应 B18。
- `App` 增加 `running sync.Map`（task id → `context.CancelFunc`）。
- `worker.go` `executeTask`：在真正调用 `a.generate(jobCtx, ...)` 之前，把 `jobCtx` 包一层 `context.WithCancel` 并 `a.running.Store(taskID, cancel)`，`defer a.running.Delete(taskID)`。
- `generation.go` `cancelTask`：事务提交成功后调用 `a.publishCancel(ctx, id)`：本地 `if cancel, ok := a.running.Load(id); ok { cancel() }`，同时 `a.Redis.Publish(ctx, "ic:task-cancel", id)`。
- `text_stream.go` `startTextEvents` 旁新增 `startCancelEvents`（订阅 `ic:task-cancel`，收到后本地 cancel）；在 `StartWorkers` 里启动。
- `executeTask` 错误路径：`classify(err)` 为 `canceled` 且 `root.Err() == nil`（不是进程关闭）时，直接 `return`，不 `retryTask` 也不 `finishTask`（任务行已被 `cancelTask` 改为 canceled，`finishTask` 也会因 status 不是 running 而跳过，但直接 return 更清晰）。释放渠道槽位的 defer 保持执行。
- 管理员取消接口 `POST /api/admin/tasks/:id/cancel` 走同一 `cancelTask`，自然覆盖。
- 测试：新增用例，启动一个阻塞的假上游，创建任务、执行 `cancelTask`，断言上游 handler 的 `r.Context().Done()` 被触发且任务状态为 canceled、余额已退。

### C8 优雅关闭与在途任务重排

对应 B22。
- `main.go`：`server.Shutdown` 使用 `context.WithTimeout(context.Background(), shutdownGrace)`；新增环境变量 `SHUTDOWN_GRACE_SECONDS`（默认 30，按规则 11 落四处）。
- `App` 增加 `shuttingDown atomic.Bool`；`StartWorkers` 传入的 `ctx` 结束时置 true；worker 循环在 `ctx.Err() != nil` 时停止领取（现有逻辑）。
- 在途任务：`executeTask` 中 `generate` 返回错误且 `a.shuttingDown.Load()` 为 true 且 `classify(err).Category == "canceled"` 时，调用 `a.requeue(context.Background(), task, false)`（即回到 queued 且清掉 deadline，不计失败、不退款），并 `return`。释放槽位照常。
- `App.Close()`：先等待 `a.workers.Wait()` 最长 `shutdownGrace`，超时则 `slog.Warn` 后继续关闭连接。
- 测试：模拟 ctx 取消时任务处于 running，断言任务回到 queued 且钱包无变化。

### C9 轮询与 SSE 空转优化

对应 B8。
- worker 领取循环：`notFound` 时等待时间从 `queuePoll` 开始每次翻倍，上限 10 秒，领取成功后重置为 `queuePoll`。`recoverTasks` 周期改为 5 秒，`reconcileExpiredOrders` 保持 1 分钟。
- `text_stream.go` `textEvents`：阅读 110-149 行现有循环，改为只在收到 `changed` 信号或首次连接时查询 `textRequestDetail`；心跳 tick 只发送 `: ping` 注释帧不查库；每 30 秒的会话校验保持。
- 验收：本地跑起来后 `pg_stat_statements` 或日志中空闲时的 `UPDATE generation_tasks ... SKIP LOCKED` 频率显著下降；SSE 断线恢复行为不变（`web/tests/text-stream.test` 通过）。

### C10 文本对话附件 N+1

对应 B9。只做批量化，不改上下文行为。
- `upstream.go` `generateText`：在遍历历史消息之前，用一条 SQL 取出该会话所有附件（`WHERE message_id = ANY($1)`）并按 message id 分组；`references()` 改为接收预取结果，不再每条消息查库。S3 读取仍逐附件，但对同一 `media_id` 在本次请求内缓存一次（map）。
- 不加历史附件数量上限（属于行为变更，写进「待确认决策」）。

### C11 列表上限与统计范围

对应 B10。
- `GET /api/admin/users`：改用 `pagination(c)`，返回 `{users, total}`；前端 `web/src/pages/admin/users` 对应改为分页表格（沿用 `admin/logs` 的 `useQuery` 分页写法）。
- `GET /api/canvas-projects`：加 `limit`（默认 200，最大 500）与 `offset`，返回 `total`；前端画布列表若超过 200 个显示「加载更多」。
- `GET /api/admin/stats`：`from/to` 缺省时默认最近 30 天，不再全表扫；前端统计页默认选中 30 天。
- 不做 keyset 分页（写进「发现但未处理」）。

### C12 HTTP 超时

对应 B11。
- `main.go` `http.Server` 增加 `IdleTimeout: 120 * time.Second`。
- 新增中间件：对非以下路由的请求设置 `context.WithTimeout(c.Request.Context(), 60*time.Second)`：`/api/text/requests/:id/events`、`POST /api/media`、`POST /api/admin/playground/test`、`POST /api/admin/channels/:id/check`、`POST /api/admin/channels/check-all`、`/api/media/:id`（大文件下载）。超时后由 `fail()` 返回 504 `timeout`。

### C13 存储膨胀与清理时机

对应 B13。
- `finishTask` 成功分支的 `UPDATE generation_tasks` 增加 `partial_text=''`（仅 `status='succeeded'` 时；失败保留便于排查）。
- `cleanup`：启动后 1 分钟先跑一次，然后每 24 小时；用 Redis `SET ic:cleanup:lock <instance> NX EX 3600` 拿锁，拿不到跳过（多实例只跑一份）。
- 媒体删除：把逐个 `RemoveObject` 改为 `RemoveObjects` 批量（minio-go 提供），每批 100。

### C14 密码策略与会话续期

对应 B19。
- 新增 `validatePassword(password, username string) error`：长度 10–128（已有）；不能与用户名相同（忽略大小写）；不能全为同一字符；至少包含两类字符（字母/数字/符号）。在注册、修改密码、找回密码、管理员重置四处调用。错误码 `weak_password`，文案「密码过于简单，请包含字母和数字，且不要与用户名相同」。
- `GET /api/auth/me`：若会话剩余有效期少于 `SESSION_DAYS` 的一半，则 `UPDATE sessions SET expires_at = now() + SESSION_DAYS` 并刷新 Cookie。
- 前端注册与改密表单同步提示规则。

### C15 高危管理操作二次验证

对应 B15（不做完整 RBAC，只做二次验证）。
- 复用 `security.go` 的 `securityProof` 结构与 `verifySecurityProof(c, tx, proof)`。以下接口请求体新增必填字段 `securityProof: { password: string; code?: string }`，在事务内先校验：
  - `POST /api/admin/payment-channels`、`PUT /api/admin/payment-channels/:id`
  - `POST /api/admin/users/:id/reset-password`
  - `POST /api/admin/users/:id/balance`
  - `DELETE /api/admin/request-logs`
  - `PUT /api/admin/platform-settings`
  - `PUT /api/admin/mail-settings`
  - `PATCH /api/admin/users/:id/role`（若存在）
- 前端：在 `web/src/hooks/` 新增 `use-security-proof.tsx`，导出 `useSecurityProof()` 返回 `requestProof(): Promise<{password; code?}>`，弹一个 antd Modal 让管理员输入当前密码与（若启用了 TOTP）验证码；上述 6 处管理页面提交前先 `await requestProof()`。
- 测试：缺 `securityProof` 或密码错误时返回 400，正确时成功。

### C16 后端死代码

对应 B5。删除 `nullableInt`；`channelFromRow` 改为只返回 `channel`，6 处调用去掉错误判断；`download` 删除恒为 nil 的 `headers` 参数。`go vet` 通过即可。

### C17 补测试

对应 B25、B26。至少新增：
- `payments_test.go`：用 `httptest.NewServer` 模拟易支付、支付宝、微信三家网关的「创建订单 → 回调验签 → 入账去重」主路径各 1 个用例（验签用测试密钥对；不能完成签名的 provider 至少覆盖「签名错误被拒绝」）。
- `content_test.go`：画布创建、保存快照、保存 viewport、历史裁剪到 20 条、删除项目释放媒体引用；素材创建/更新/删除与跨用户越权 403。
- `migrations_test.go`：调用真实 `runMigrations` 从空库升到最新版本，再重复执行一次断言幂等。
- Fuzz：`FuzzResponseError`（`upstream.go` 的错误解析）与 `FuzzExtractMediaIDs`，各跑 `-fuzztime=10s` 一次确认不 panic，并把种子语料提交。

---

## 3. 批次 D：前端

### D1 ESLint、tsconfig、vitest

对应 W17、W18、W19、W20。

1. 安装 `eslint@9`、`typescript-eslint`、`eslint-plugin-react-hooks`、`eslint-plugin-react-refresh`、`globals`；新建 `web/eslint.config.js`（flat config）：`typescript-eslint` recommended + `react-hooks` recommended + `react-refresh/only-export-components: warn`；忽略 `dist`、`public`、`tests`。`package.json` 增加 `"lint": "eslint src"`，`build` 改为 `tsc --noEmit && eslint src && vite build`。修复所有 error 级别问题；`react-hooks/exhaustive-deps` 的 warning 允许保留但要处理原来 5 处 `eslint-disable-next-line` 所在位置：要么补依赖，要么保留注释并在报告里说明原因。
2. `tsconfig.json`：`target` 改 `ES2022`；增加 `"noUnusedLocals": true, "noUnusedParameters": true`。修复由此暴露的未使用变量（删除或加 `_` 前缀）。
3. vitest：安装 `vitest`、`@testing-library/react`、`@testing-library/jest-dom`、`jsdom`；新建 `web/vitest.config.ts`（`environment: jsdom`，`alias @ → src`，`setupFiles` 引入 jest-dom）。A2 已删除使用 `bun:test` 的 `web/tests/image-thumbnail.test.ts`，把 `web/tests/*.test.cjs` 逐个迁移为 `web/tests/*.test.ts`，用真实 `import` 替代手写 `transpileModule + vm` 加载；断言库用 vitest 的 `expect`。迁移完成后 `package.json` 的 `test` 改为 `vitest run`，删除 `.cjs` 文件。原有 40 个用例数量不能减少。
4. 新增至少 3 个组件测试：`ModelPicker` 渲染平台模型列表并可选择；`hasPlatformModel` 与 config store 的 `hydratePlatformModels` 行为；`ErrorBoundary`（D2 新增）渲染 fallback。

### D2 ErrorBoundary 与路由错误页

对应 W21。
- 新建 `web/src/components/layout/app-error-boundary.tsx`：class 组件 `componentDidCatch` 记录 `console.error`，fallback 显示「页面出现错误」+「刷新页面」按钮（`window.location.reload()`）。
- `router.tsx`：根级与 `UserLayout`、`UserCenterLayout`、`AdminLayout` 三个布局路由加 `errorElement`，复用同一个 fallback 组件；对 `lazy()` 加载失败（`ChunkLoadError` 或 `Failed to fetch dynamically imported module`）的情况，fallback 自动 reload 一次（用 `sessionStorage` 标记避免死循环）。
- `AppProviders` 用 `AppErrorBoundary` 包住 `children`。

### D3 打包分块与版本检查本地化

对应 W14、W25。
- `vite.config.ts` 增加 `build.rollupOptions.output.manualChunks`：`react-vendor`（react、react-dom、react-router、react-router-dom、scheduler）、`antd`（antd、@ant-design/*、rc-*）、`query`（@tanstack/react-query）、`i18n`（i18next、react-i18next）、`motion`。其余交给 Vite 默认。
- 安装 `rollup-plugin-visualizer` 为 devDependency，`package.json` 增加脚本 `"analyze": "ANALYZE=1 vite build"`，仅在 `process.env.ANALYZE` 时启用插件输出 `dist/stats.html`（`stats.html` 加入 `.gitignore`）。
- 检查 `streamdown` 的 mermaid 依赖是否在入口 chunk：如果 `dist/assets/index-*.js` 仍引用 mermaid，则把渲染 Markdown 的组件（`grep -rn "streamdown" web/src` 找到）改为 `lazy()` 按需加载。
- `web/src/hooks/use-version-check.ts` 硬编码了上游仓库 `raw.githubusercontent.com/basketikun/...` 的版本与 CHANGELOG 地址，每次挂载都请求一次，对本仓库没有意义。删除 `checkLatestVersion`、`checkLatestRelease` 中的远程 fetch，版本弹窗只展示本地内嵌的 `__APP_RELEASES__`；`hasNewVersion` 恒为 false，删除对应的「有新版本」提示与「检查更新」按钮（在 `version-release-modal.tsx` 与 `user-status-actions.tsx` 中）。`vite.config.ts` 的 `__APP_RELEASES__` 只注入 `parseChangelog(localChangelog).slice(0, 5)`。
- 验收：报告中记录优化前后 `dist/assets/index-*.js` 大小；目标入口 chunk ≤ 600 KB（未 gzip）；`grep -rn basketikun web/src` 为空。

### D4 生图/视频工作台去重

对应 W3。
- 新建 `web/src/components/generation/log-panel.tsx`（`LogPanel`、`LogCard`）、`web/src/components/generation/reference-order-buttons.tsx`；新建 `web/src/lib/generation-log.ts`（`moveListItem`、`fileBaseName`、`fileExtension`、`summaryToLog` 的公共部分、`GenerationLog` 类型）。两页面 import 这些实现，删除本地副本。
- 两页面的初始化 effect（`Promise.all([getPublicModels(), ..., getGenerationPreferences()])`）合并进 `hooks/use-generation-batches.ts` 的一个新导出 `useWorkbenchBootstrap(capability)`。
- 验收：两页面各缩减至少 150 行；生图与视频页手动生成一次、删除记录、预览历史正常。

### D5 模型列表单入口与数据层统一

对应 W11、W12、W13。
1. `web/src/components/layout/app-providers.tsx` 导出 `queryClient`。新建 `web/src/hooks/use-public-models.ts`：`usePublicModels()` = `useQuery({ queryKey: ["public-models", sessionVersion], queryFn: getPublicModels, staleTime: 60_000 })`；导出 `fetchPublicModels()` = `queryClient.fetchQuery(...)` 供非组件代码（`image.ts`、`audio.ts`、`video.ts`、`agent-site-tools.ts`、config store 的 `hydratePlatformModels`）使用。删除 `services/api/models.ts` 中重复的 `listModels`（若与 `getPublicModels` 等价）。
2. `pages/user/logs`、`pages/user/stats` 改为 `useQuery`（`keepPreviousData`，queryKey 含全部筛选参数），删除手写 loading/reqId 竞态代码。
3. 画布轮询：把 `project.tsx` 中两个 1.8s `setInterval` 恢复效果迁入 D6 拆出的 `use-canvas-generation-recovery.ts`，并改为：依赖数组只包含「pending 的 id 列表」（用 `useMemo` 从 nodes 算出并 `join(",")` 成字符串作为依赖），节点其他字段变化不再重建定时器。文本请求优先使用已有 SSE（`services/api/text.ts` 的 EventSource 模式）而非轮询，图片仍轮询。

### D6 拆分 `pages/canvas/project.tsx`

对应 W1、W2。目标：`project.tsx` ≤ 1800 行，`CanvasNode` 直接 props ≤ 20 个。分五步，每步完成后 `typecheck + test + 手动打开画布拖动/连线/生成一次`，然后提交。

1. **`pages/canvas/hooks/use-canvas-generation-recovery.ts`**：迁出图片任务恢复 effect、文本请求恢复 effect、Config 节点状态同步 effect（约 560–770 行）。输入 `{ nodes, connections, projectLoaded, setNodes, t }`，无返回。
2. **`pages/canvas/hooks/use-canvas-shortcuts.ts`**：迁出 `keydown` 处理 effect（约 1770–1860 行）。输入为一个 `actions` 对象（`undo/redo/selectAll/group/ungroup/copy/paste/pasteSystem/deleteSelection/escape`），用 `useRef` 持有最新 actions 以保持 effect 依赖为空数组。
3. **`pages/canvas/hooks/use-canvas-clipboard.ts`**：迁出复制、粘贴、系统剪贴板读取、文件拖放与 `createImageFileNode`（约 1700–1770 与相关 useCallback）。
4. **`lib/canvas/canvas-generate-node.ts`**：把 `handleGenerateNode`（约 2485–3041 行）按 `mode` 拆为 `generateImageNode`、`generateTextNode`、`generateVideoNode`、`generateAudioNode`、`generatePluginBuiltinNode` 五个纯 async 函数，每个接收 `GenerateNodeDeps`（`nodesRef、connectionsRef、setNodes、setDialogNodeId、message、t、projectId、config、startGenerationRequest、finishGenerationRequest、completeVideoNodeTask`）与 `(nodeId, prompt)`。`project.tsx` 中的 `handleGenerateNode` 变成一个按 mode 分派的 30 行以内函数。`handleRetryNode` 同样拆到该文件。
5. **`CanvasNode` 传参瘦身**：新增 `CanvasNodeActions` 类型，把全部 `on*` 回调合成一个 `actions` prop，在 `project.tsx` 用 `useMemo` 构造一次（回调本身已是 `useCallback`）。派生布尔值中 `referenceSelectionState`、`showPanel`、`isSelected`、`isRelated`、`batchExpanded`、`groupChildCount`、`mentionReferences` 保留为 props，但保证传入值引用稳定（`Set` 与 `Map` 已 memo 化即可）。若完成后 props 仍 > 20 个，把 `selectedNodeIds`、`hoveredNodeId`、`expandedBatchNodeIds`、`dialogNodeId` 四个状态迁入 `stores/canvas/use-canvas-ui-store.ts`，`CanvasNode` 内部按 `data.id` 用 selector 订阅。

**验收**：`wc -l web/src/pages/canvas/project.tsx` ≤ 1800；`npm test` 通过；手动检查清单（写入 pending-test）：拖动、缩放、框选、连线、复制粘贴、撤销重做、Delete、Escape、图片上传拖放、生图节点生成、文本节点生成、批量生成、失败重试、刷新后恢复进行中的任务。

### D7 拆分 `local-agent-panel.tsx`

对应 W7。把 :1511–1666 的模块级工具函数迁到 `web/src/lib/agent/agent-panel-utils.ts`；把连接管理（SSE 连接/重连/断开）、审批队列、历史合并三块各拆为 `components/agent/hooks/use-agent-connection.ts`、`use-agent-approvals.ts`、`use-agent-history.ts`。目标文件 ≤ 800 行。验收：`web/tests/agent-session.test`（迁 vitest 后）通过；连接本地 Agent 发送一条消息正常。

### D8 移动端提示、快捷键面板、可访问性

对应 W23、W24。
- `pages/canvas/project.tsx` 渲染前：`window.matchMedia("(pointer: coarse) and (max-width: 768px)")` 为真时，顶部显示一条可关闭的提示「画布建议在桌面端使用，移动端仅支持浏览」（关闭状态存 `localStorage`）。不改交互逻辑。
- 画布工具栏加一个「?」按钮，打开 antd Modal 列出快捷键（内容来自 `docs/content/docs/canvas/canvas-shortcuts*.mdx`，写成常量数组）。
- `pages/admin/**` 中所有 `<div onClick>` 改为 `<button type="button">` 或 antd `Button type="text"`，保持样式；表格操作列的图标按钮补 `aria-label`。

### D9 列表分页与虚拟化

对应 W15。
- 先 `grep -rn "listAssets\|/assets" web/src/services/api/assets.ts server/internal/platform/content.go` 确认素材接口是否支持 `limit/offset`。支持则 `pages/assets/index.tsx` 改为服务端分页（`useQuery`，页码与筛选放 queryKey），`use-asset-store` 只保留画布侧栏需要的最近 N 条缓存；不支持则在后端补 `limit/offset/keyword/kind` 参数后再改前端。
- 安装 `@tanstack/react-virtual`，用于 `canvas-side-panel.tsx` 左侧节点列表与素材列表（超过 100 项时启用）。

---

## 4. 批次 E：文档同步

### E1 CHANGELOG 与待测试清单

按执行规则第 7 条，确认每个用户可感知的变更都在 `CHANGELOG.md` `Unreleased` 有一条，每个批次在 `pending-test.mdx` 与 `pending-test.zh-CN.mdx` 有验收点。不切版本。不重写 `docs/content/docs/overview/*`。

---

## 5. 明确不在本轮做的事项

### 5.1 推迟：审查清单「三、部署、CI 与仓库」中除仓库清理以外的项

`improvement-review.md` 第三部分 D1–D17 中，A2 只覆盖 D9、D12、D16 与 D7 的 `.dockerignore` 部分，其余本轮一项不做。其中几项与代码有交叉、执行时容易顺手做掉，特别提醒不要做：

- 不要改 `.github/workflows/*`，包括为后端 CI 补数据库 services、新建前端 CI、镜像发布、Dependabot、release 校验。
- 不要改 `Dockerfile`、`server/Dockerfile`、`nginx.conf`；两份 `docker-compose*.yml` 只允许按规则 11 追加环境变量透传，不加 healthcheck、logging、mem_limit。
- 不要改插件加载与清单校验（`plugin-loader.ts`、`plugin-registry.ts`、`PLUGIN_REGISTRY_URL`、`plugins/canvas/registry/build.mjs`、`publish-plugins.yml`）。
- 不要重写 `docs/content/docs/overview/quick-start*`、`features*`、`docker*`，不要新建 OpenAPI 文档。
- 不要删除 `app.go` 中 `IMAGE_WORKER_CONCURRENCY` 兼容分支，不要调整 `WORKER_CONCURRENCY` 示例值，不要动 CORS 允许头列表。
- 不要新建备份、恢复、升级脚本。

### 5.2 审查项保留，等待所有者决定

| 审查项 | 原因 |
|---|---|
| B2 `Row map` 全量改结构体 | 涉及全部查询，无行为收益，风险高；建议在后续按模块逐步做 |
| B6 时区与超时常量配置化 | `AGENTS.md` 要求改默认值前与用户确认 |
| B12 媒体改预签名 URL / X-Accel-Redirect | 当前 MinIO 不对外暴露，需要部署拓扑决策 |
| B10 中的 keyset 分页 | 前端表格依赖页码，改动面大 |
| B9 中的历史附件上限 | 会改变模型看到的上下文，属于行为变更 |
| W16 拖动时派生数据重算 | 需要先做性能剖析确认瓶颈；D6 第 5 步已部分缓解 |
| W22 i18n 二选一 | 是产品决策：只保留中文并移除 i18next，或补齐后台英文 |
| Playwright 端到端测试 | 需要完整 Docker 环境作为 CI 依赖，建议单独立项 |

---

## 6. 提交与分支约定

- 分支：`improvement/round-1`。
- 每个任务一个提交，不要把多个任务合成一个提交，也不要把一个任务拆成十几个零碎提交。
- 提交前 `git diff --stat` 自查是否误改了范围外文件，特别是第 5.1 节列出的文件。
- 不要 `git push --force`。不要 rebase 已推送的提交。
- 完成后不要合并到 `main`，等待审查。

---

## 7. 执行顺序总表

C 批次与 D 批次互相独立，可以交替进行；批次内按依赖列执行。

| 顺序 | 任务 | 依赖 |
|---|---|---|
| 1 | A1 | — |
| 2 | A2 | A1 |
| 3 | C1、C2 | — |
| 4 | C3 | C2 |
| 5 | C4、C5、C6、C16 | C3 |
| 6 | C7、C8、C9 | C3 |
| 7 | C10、C11、C12、C13、C14 | — |
| 8 | C15 | C5 |
| 9 | C17 | C1–C16 全部完成 |
| 10 | D1、D2、D3 | A1、A2 |
| 11 | D4、D5 | D1 |
| 12 | D6 | D5 |
| 13 | D7、D8、D9 | D1 |
| 14 | E1 | 全部 |

---

## 8. 交付物（审查者将逐项核对）

执行完成后在仓库新建 `docs/implementation-report-round1.md`，包含：

1. **任务状态表**：每个任务编号一行（A1、A2、C1–C17、D1–D9、E1 共 29 项），状态取 `完成 / 部分完成 / 未做`，后两者必须写原因。
2. **验证记录**：每个任务的验证命令与结果摘要（例如 `npm run typecheck: 0 errors`、`go test ./...: ok ... SKIP 0`）。后端数据库测试若未跑，逐任务标注。
3. **关键数字**：`wc -l` 前后对比（`project.tsx`、`local-agent-panel.tsx`、`image.ts`、`use-config-store.ts`）；`dist/assets/index-*.js` 前后大小；本地带 `TEST_DATABASE_URL` 运行时 `go test` 的 Skip 数；ESLint error 数。
4. **待确认决策**：本文档中标注为默认值的地方（频控数值、超时时间、密码规则等）以及执行中自行做出的决定。
5. **发现但未处理**：范围外的问题，包括执行中注意到的部署与 CI 问题（记下来即可，不做）。
6. **与本文档的差异**：行号漂移、函数已不存在、方案调整。
7. **手动验收清单**：A1、C7、C15、D6 要求的手动操作是否执行、结果如何。

审查将重点检查：A1 是否残留直连代码；C1 视图替换是否遗漏；C7/C8 是否影响结算与退款；D6 拆分后是否有行为回归；所有新增环境变量是否同时出现在 `app.go`、`.env.example`、两份 compose 与 README；第 5.1 节列出的文件是否被误改。
