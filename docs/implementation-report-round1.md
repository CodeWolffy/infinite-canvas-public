# 第一轮改进实施报告

对应 [implementation-plan-round1.md](implementation-plan-round1.md)。分支 `improvement/round-1`，从 `main`（`7608911`）分出，未合并回 `main`。

执行方式：后端 C 批次由主模型串行完成（多任务集中在 `app.go`/`worker.go`，并行会互相覆盖）；前端与后端文件集不重叠的任务派给子代理并行执行，由主模型逐项审查、验证后提交。

---

## 1. 任务状态表

| 任务 | 状态 | 说明 |
| :--- | :--- | :--- |
| A1 删除浏览器直连子系统并重写 config store | 完成 | 删除 17 个文件；`image.ts` 1054→338 行，`use-config-store.ts` 573→250 行 |
| A2 仓库清理 | 完成 | `api/` 打 `legacy-node-api` 标签后删除；`canvas-proxy/`、render/vercel 配置、bun 锁文件一并删除 |
| C1 索引与渠道可用视图 | 完成 | 迁移 020；7 处渠道可用判定统一改用视图 |
| C2 迁移文件自动注册 | 完成 | `//go:embed migrations/*.sql` + `loadMigrations` |
| C3 请求 ID、日志、指标、worker 吞错 | 完成 | 新增 `observability.go`；`LOG_LEVEL`/`LOG_FORMAT`/`METRICS_ADDRESS` |
| C4 频控补齐 | 完成 | 6 个写接口，兑换码另加按 IP 一层 |
| C5 管理审计中间件 | 完成 | admin 组写请求统一审计；敏感词改为同事务 |
| C6 加密密钥可轮换 | 完成 | `v1:` 前缀 + `CHANNEL_ENCRYPTION_KEY_PREVIOUS` + `rotate-keys` 子命令 |
| C7 任务取消传播 | 完成 | 本地 cancel + Redis 广播；取消后不重试不结算 |
| C8 优雅关闭与在途任务重排 | 完成 | `SHUTDOWN_GRACE_SECONDS`；退出时在途任务回到 queued |
| C9 轮询与 SSE 空转优化 | 完成 | 领取指数退避至 10 秒；心跳改 `: ping` 不查库 |
| C10 文本对话附件 N+1 | 完成 | 一次批量查询 + 单请求内 media 读取缓存 |
| C11 列表上限与统计范围 | 完成 | 用户/画布分页；统计默认 30 天 |
| C12 HTTP 超时 | 完成 | `IdleTimeout` 120s + 请求级 60s（慢路由豁免） |
| C13 存储膨胀与清理时机 | 完成 | 结算清空 `partial_text`；启动即清理 + Redis 锁 + 批量删除 |
| C14 密码策略与会话续期 | 完成 | `validatePassword` 四处统一；`/auth/me` 过半续期 |
| C15 高危管理操作二次验证 | 完成 | 7 个接口 + 前端 `use-security-proof` |
| C16 后端死代码 | 完成 | 删 `nullableInt`；`channelFromRow` 收窄；`download` 去参数 |
| C17 补测试 | 完成 | 支付三家、画布/素材、迁移幂等、2 个 fuzz |
| D1 ESLint、tsconfig、vitest | 完成 | 8 个 `.cjs` 用例迁移为 vitest；新增 9 个组件/单元用例 |
| D2 ErrorBoundary 与路由错误页 | 完成 | 全局兜底 + 各层 `errorElement` + chunk 失败自动刷新一次 |
| D3 打包分块与版本检查本地化 | 完成 | 入口 chunk 1342.99 kB → 238.22 kB；版本检查不再请求上游 |
| D4 生图/视频工作台去重 | 完成 | image 946→749、video 847→694；抽出 `components/generation/*` 与 `lib/generation-log.ts` |
| D5 模型列表单入口与数据层统一 | 完成 | `usePublicModels`/`fetchPublicModels` 单入口；用户日志与统计改 react-query |
| D6 拆分 project.tsx | 部分完成 | 第 1–3 步完成（3779→3388 行）；第 4、5 步（生成编排按 mode 拆分、`CanvasNode` 传参瘦身）未完成，见第 5 节 |
| D7 拆分 local-agent-panel.tsx | 完成 | 1662→613 行，拆出 4 个 hook + `agent-panel-utils.ts` |
| D8 移动端提示、快捷键面板、可访问性 | 部分完成 | 管理后台可访问性已完成；画布移动端提示与快捷键面板未完成，见第 5 节 |
| D9 列表分页与虚拟化 | 部分完成 | 素材页服务端分页完成；`@tanstack/react-virtual` 虚拟滚动未做，见第 5 节 |
| E1 CHANGELOG 与待测试清单 | 完成 | `CHANGELOG.md` Unreleased 追加 22 条；两份 `pending-test` 追加 15 条验收点 |

---

## 2. 验证记录

环境：Windows + Git Bash；后端测试使用本地 Docker 起的独立 PostgreSQL/Redis/MinIO（`TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/canvas_test`、`TEST_REDIS_ADDR=127.0.0.1:56379`、`TEST_MINIO_ADDR=127.0.0.1:59000`）。

| 任务 | 验证命令 | 结果 |
| :--- | :--- | :--- |
| A1 | `npm run typecheck` / `npm test` / `npm run build` | 0 error / 56 passed / 构建成功 |
| A1 | `grep -rn "apiKey\|Bearer \|x-goog-api-key" web/src` | 只剩管理后台渠道页面的字段名引用 |
| A1 | `grep -rn "openConfigDialog\|isAiConfigReady\|useEffectiveConfig\|channelMode\|withLocalProxy" web/src` | 空 |
| A2 | `git ls-files api canvas-proxy render.yaml vercel.json web/vercel.json web/bun.lock canvas-agent/bun.lock web/tests/image-thumbnail.test.ts` | 空 |
| A2 | `npm ci` + `npm run build` | 通过 |
| A2 | `docker build -t ic-web-test .` / `docker build -f server/Dockerfile -t ic-api-test .` | 均成功 |
| C1–C17 | `go vet ./...` / `go build ./...` | 通过 |
| C1–C17 | `go test -count=1 -v ./...`（带 TEST_* 环境变量） | `ok server` / `ok platform`；**70 个顶层用例 PASS / 0 FAIL / 1 SKIP**（`TestAudioDurationBillingAndProbeIsolation` 需要 ffprobe） |
| C3 | 起真实服务：`/ready` 200；`/metrics` 含 `ic_http_requests_total`/`ic_tasks_queued`；`X-Request-ID` 合法值回显、非法值换 uuid；`LOG_FORMAT=json` 生效；`/ready`、`/metrics` 不记访问日志 | 全部符合预期 |
| C4 | `TestWriteEndpointsAreRateLimited` | 第 11 次兑换返回 429 |
| C6 | `TestSealVersionedRoundTrip` / `TestRotateKeysReencryptsLegacyCiphertext` | 通过（轮换后旧密钥不再需要） |
| C7 | `TestCancelPropagatesToUpstream` | 上游 `r.Context().Done()` 触发；状态 canceled；余额全额退回 |
| C8 | `TestShutdownRequeuesRunningTask` | 任务回到 queued、deadline 与 worker_token 清空、钱包不变 |
| C11 | `TestModelListHidesUnavailableChannels` | 渠道自动停用/无可用 Key 后模型从列表消失 |
| C15 | `TestHighRiskAdminOperationsRequireSecurityProof` | 缺凭据 400、密码错误 400 且不改数据、正确 200 |
| C17 | `FuzzResponseError` / `FuzzExtractMediaIDs` 各 `-fuzztime=10s` | 无 panic（9.4 万 / 12.5 万次执行） |
| D1 | `npm run typecheck` / `npm test` / `npm run build` | 0 error / 65 passed / 构建成功（build 前置 eslint，0 error） |
| D3 | `npm run build` | 入口 chunk `index-DgMLaELS.js` 238,215 B；`ANALYZE=1 npx vite build` 生成 `dist/stats.html` |
| D3 | `grep -rn "raw.githubusercontent" web/src` | 版本检查相关已全部删除（只剩 `prompt-source-presets.ts` 里第三方提示词源） |
| D4–D9 | `npm run typecheck` / `npm test` | 0 error / 65 passed |

---

## 3. 关键数字

| 指标 | 改进前 | 改进后 |
| :--- | :--- | :--- |
| `web/src/services/api/image.ts` | 1054 行 | **339 行** |
| `web/src/stores/use-config-store.ts` | 573 行 | **251 行** |
| `web/src/pages/canvas/project.tsx` | 3779 行 | **3388 行**（目标 ≤1800，第 4、5 步未完成） |
| `web/src/components/agent/local-agent-panel.tsx` | 1666 行 | **613 行** |
| `web/src/pages/image/index.tsx` | 946 行 | **749 行** |
| `web/src/pages/video/index.tsx` | 847 行 | **694 行** |
| `dist/assets/index-*.js`（未 gzip） | 1,350,479 B | **238,598 B**（gzip 81.8 kB） |
| 前端用例数 | 56（node:test + 手工 transpile 源码） | **65**（vitest + Testing Library） |
| ESLint error | 无 ESLint | **0** |
| 后端测试（带数据库） | 约 44 个用例 | **70 PASS / 0 FAIL / 1 SKIP** |

D3 拆出的 chunk：`antd` 1198 kB、`react-vendor` 285 kB、`motion` 124 kB、`i18n` 61 kB、`query` 37 kB。`mermaid` 已是独立懒加载 chunk（505 kB），不在入口。

---

## 4. 待确认决策

以下为本轮按计划默认值执行、建议由项目所有者确认的取值：

1. **写接口频控数值**（C4）：兑换码 10 次/分钟/用户 + 30 次/分钟/IP，媒体上传 60，报价 120，画布保存 120，创建对话 30，创建画布 30。
2. **请求级处理时限**（C12）：非豁免路由 60 秒；`IdleTimeout` 120 秒。
3. **退出宽限**（C8）：`SHUTDOWN_GRACE_SECONDS` 默认 30 秒。
4. **密码规则**（C14）：长度 10–128、至少两类字符、不能与用户名相同、不能全为同一字符。
5. **统计默认时间范围**（C11）：`/api/admin/stats` 未传 `from`/`to` 时默认最近 30 天。
6. **画布列表分页**（C11）：默认 200、最多 500；素材接口沿用 `pagination`（默认 50、最多 200）。
7. **清理锁过期**（C13）：`ic:cleanup:lock` TTL 1 小时，清理周期 24 小时。
8. **模型列表缓存**（D5）：`usePublicModels`/`fetchPublicModels` 的 `staleTime` 60 秒。
9. **`shadcn` 依赖保留**（A1，偏离计划）：计划要求删除该依赖并移除 `@import "shadcn/tailwind.css"`，实测删除后 Tailwind 会把 `ui/select.tsx` 的 `data-open:`/`data-closed:` 编译成 `[data-open]`/`[data-closed]`，而 Radix 实际写 `data-state="open"`，会导致下拉动效失效。因此保留依赖与 import；其余 5 个未使用依赖已删除。
10. **`grep -rn basketikun web/src` 无法为空**（D3）：版本检查里的上游地址已删除，但仍有 3 处同仓库引用——`constant/env.ts` 的 `PLUGIN_REGISTRY_URL` 默认值、`github-link.tsx` 的仓库链接、`canvas-agent` 的 `npx` 提示文案。这三处属计划 5.1 明确禁止改动的范围，因此该验收标准与计划自身冲突，未强行达成。
11. **`npm run analyze` 在 Windows 下不可用**（D3）：脚本按计划原文写成 `ANALYZE=1 vite build`，在 cmd.exe 下不生效；已验证的调用方式是 Git Bash 里 `ANALYZE=1 npx vite build`。若要跨平台，需要引入 `cross-env`（新增依赖）或改成 `vite build --mode analyze`。
12. **`version.*` 9 个 i18n 键成为孤儿**（D3）：`currentVersion`、`latestVersion`、`checking`、`checkUpdates`、`readFailed`、`changelogFailed`、`updated`、`updateFailed`、`latest` 中英各一份，对应 UI 已删。计划未要求清理 i18n，暂留。
13. **`index.html` 仍会 modulepreload `antd` chunk**（D3，发现未处理）：根因是 `router.tsx` 顶层 `import { Spin } from "antd"` 作为 Suspense fallback，首屏实际 JS 传输约 1.82 MB（gzip ≈576 kB）。「入口 chunk ≤600 kB」这一指标已达成，但首屏总传输未优化。
14. **文本恢复改为 SSE**（D5/D6）：按计划 D5「文本请求优先使用已有 SSE」，画布文本恢复由 1.8 秒轮询改为订阅 `watchTextRequest`，并保留原有「404 三次容忍后标记中断」语义。相对轮询有可观察差异（传输方式变化、`expired` 事件会派发 `auth:unauthorized`、404 不再按 1.8 秒重试）。

---

## 5. 未完成事项与原因

| 事项 | 状态 | 原因 |
| :--- | :--- | :--- |
| D6 第 4 步：`handleGenerateNode` 按 mode 拆成 5 个纯函数、`handleRetryNode` 迁到 `lib/canvas/canvas-generate-node.ts` | 未做 | 该步与第 5 步共约 800 行改动，且直接决定画布生成行为，需要逐条人工回归验证；本轮剩余时间内无法完成并验证，故留待下一轮。`project.tsx` 当前 3388 行，未达 ≤1800 目标 |
| D6 第 5 步：`CanvasNodeActions` 合并回调、`CanvasNode` props ≤20 | 未做 | 同上，依赖第 4 步先落地 |
| D8 画布部分：移动端提示、快捷键面板 | 未做 | 与 D6 第 4、5 步改同一文件 `project.tsx`，为避免与拆分冲突而让路 |
| D9 虚拟滚动：`@tanstack/react-virtual` 接入 `canvas-side-panel.tsx` | 未做 | 素材页服务端分页（D9 的主要目标）已完成；虚拟滚动涉及画布侧栏 635 行组件的列表渲染改造，风险与收益比不适合在剩余时间内完成 |

---

## 6. 发现但未处理

- `docs/content/docs/overview/quick-start*.mdx` 仍在描述「导入 Vercel、由浏览器直连 OpenAI 兼容地址」，与平台架构矛盾；按计划 5.1 本轮不重写。
- 两份 `pending-test` 中仍保留历史版本的「本地代理」「WebDAV 同步」验收记录，对应功能已在 A1 删除；属历史记录，未清理。
- `runMigrations` 的测试兜底路径（`Config.DatabaseURL` 为空时走连接池的扩展协议）无法执行建库阶段那条多命令语句；生产路径（简单协议连接）不受影响。`migrations_test.go` 因此显式传入 `DatabaseURL`。
- 后端访问日志对每个请求都写一行（`/health`、`/ready`、`/metrics` 与 SSE 除外），生产反代健康检查频率高时可再降噪。
- `project.tsx` 的 `hasPlatformModel` 出现在 5 个 `useCallback` 依赖数组里（A1 改名遗留，模块级函数不需要作为依赖），ESLint 报 `react-hooks/exhaustive-deps` warning；属 warning 级，计划允许保留。
- `web/src/components/agent/hooks/use-agent-connection.ts` 等文件仍有 `react-hooks/exhaustive-deps` warning（原文件同类 warning 即存在）。
- keyset 分页、`Row map` 全量改结构体、媒体预签名 URL、历史附件上限等按计划 5.2 保留待定。

---

## 7. 与本文档的差异

1. **行号漂移**：计划中的行号基于 `main@7608911`，执行过程中文件被前置任务改动，实际按内容定位。`local-agent-panel.tsx` 计划写 1666 行，实际检出 1662 行。
2. **A1 的 i18n 清理范围扩大**：计划只要求清理 `config.*`；实际 `modelPlugin.*` 整个命名空间只被已删的模型脚本编辑器使用，`apiErrors.*` 中大量键也只被已删代码使用，且会让验收 grep 出现误报，因此一并删除/收敛。
3. **A1 保留 `shadcn`**：见「待确认决策」第 9 条。
4. **C1 视图替换范围**：计划提到「admin.go、public_status.go 中若有同类判定也一并替换」。核对后 `admin.go` 的 `/models/:id/channels` 是管理端绑定列表（有意展示全部绑定），`public_status.go` 的健康计算需要区分可用/不可用/降级三态（视图会直接过滤掉不可用项，替换后会丢失降级态），两者都不是同一判定，故未替换。
5. **C15 缺 `securityProof` 的错误码**：`securityProof` 结构上的 `binding:"required"` 会让「完全缺失」在绑定阶段返回 `invalid_request`（400），`security_proof_required` 只在「字段存在但密码为空白」时出现。未改动共享结构以免影响 `security.go` 里 4 个既有接口的错误码。
6. **C11 用户列表补了服务端筛选**：计划只要求「改用 pagination + 返回 total」，但该页原有客户端筛选，改分页后若仍在客户端过滤会得到错误结果，因此为 `/api/admin/users` 增加 `keyword`/`role`/`status` 参数。D9 的素材列表同理补了 `keyword`/`kind` 与 `total`。
7. **C14 注册表单不校验「密码≠用户名」**：前端改密表单用当前用户名做了该校验；注册表单若要用表单实例读取用户名会让 `session-isolation` 用例里「把组件当函数调用」的既有测试模式失效，因此注册表单只做组合规则校验，用户名相同由后端返回明确错误。
8. **C17 测试范围**：易支付覆盖「创建订单 → 回调验签 → 入账 → 重复回调幂等 → 篡改金额被拒」完整主路径；支付宝与微信按计划允许的降级方式覆盖「签名错误被拒绝且不入账」（用测试 RSA 密钥对，使失败确实发生在验签环节）。越权断言按实际实现返回 404 而非计划写的 403。
9. **新增 `@testing-library/user-event`**（D1）：组件测试需要它驱动 Radix Select 的打开与选择，计划未列出。
10. **D4 的 `LogCard` 用 `variant` 区分两页**：核对后发现两页的 `LogCard` 并不字节相同（image 显示缩略图与数量，video 显示尺寸/分辨率/秒数，DOM 结构也不同），因此共用组件增加 `variant: "image" | "video"`，而不是按计划「以行为更完整的那份为准」直接合并。
11. **D4 的 `useWorkbenchBootstrap` 接收 options 对象**：模型/偏好/初始批次选择是页面特有的，纯 `capability` 参数无法覆盖，因此改为 options 对象并在报告里说明。
12. **D7 拆出 4 个 hook 而非 3 个**：计划点名连接/审批/历史三块，实际事件合并（`handleAgentEvent`/`showAgentError`）不属于任何一块，单独成 `use-agent-events.ts` 才能把文件压到 800 行以内。`sendPrompt`、`addAttachments` 保留在组件内，因为 `agent-session` 用例按变量名从该文件抽取它们。
13. **D6 测试锚点更新**：`image-recovery`、`text-recovery`、`request-session` 三个用例从 `project.tsx` 抽取被搬走的函数，已把抽取路径改到新的 hook 文件（`text-recovery` 改为抽取 `applyTextDetail` 以匹配 SSE 版实现），断言未改、用例数未减。

---

## 8. 手动验收清单

需要人工执行的操作已逐条写入 `docs/content/docs/progress/pending-test.mdx` 与 `pending-test.zh-CN.mdx` 的「第一轮改进」小节，共 15 条验收点，覆盖 A1（模型未就绪提示、设置页入口）、C4（429）、C6（密钥轮换）、C7（取消中断上游）、C8（重启重排）、C11（分页）、C15（二次验证弹窗）、C3（指标与 `/ready`）、D2（错误兜底）与 D6（画布交互回归清单）。

本轮已实际执行的手动验证：C3 的 `/ready`、`/metrics`、`X-Request-ID`、JSON 日志与访问日志豁免（起真实服务 + curl）；A2 的两个 Docker 镜像构建；D3 的 `ANALYZE=1 npx vite build` 产物检查。画布交互（拖动、连线、生成、恢复）与密钥轮换全流程需按待测试清单人工确认。
