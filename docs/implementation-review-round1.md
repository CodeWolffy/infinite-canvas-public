# 第一轮改进验收报告

对应 [implementation-plan-round1.md](implementation-plan-round1.md) 与执行方的 [implementation-report-round1.md](implementation-report-round1.md)。审查对象：分支 `improvement/round-1`（30 个提交，基点 `main@7608911`），工作区干净。

结论：验收时发现两处必须返工（第 2 节 R1、R2），**已由审查方在同一分支直接修复并补回归测试**（见第 6 节）。其余 27 项完成质量符合计划，4 个未完成子项的理由成立，转入下一轮。

## 1. 我实际复跑的验证

| 项目 | 结果 |
| :--- | :--- |
| `web`：`npm run typecheck` / `npm test` / `npm run build` | 0 error / 65 passed（10 个文件）/ 构建成功，入口 chunk 238.60 kB |
| `web`：`npx eslint src` | 0 error，76 warning |
| `server`：`go vet ./...` / `go build ./...` | 通过 |
| `server`：带 `TEST_*` 的 `go test -count=1 ./...` | `ok server` / `ok platform`（46.5s） |
| `server`：不带 `TEST_*`（模拟当前 CI） | 通过，但绝大多数用例仍 Skip，属已推迟的 CI 项，不计入本轮 |
| `docker build -f server/Dockerfile .` / `docker build .` | 两个镜像均构建成功（`.dockerignore` 改动无副作用） |
| 禁改文件 | `.github/`、`Dockerfile`、`server/Dockerfile`、`nginx.conf`、迁移 001–019 均无 diff；`AGENTS.md` 只改了第 26 行那半句；两份 compose 只加了规则 11 允许的环境变量 |
| 新增环境变量四处落地 | `CHANNEL_ENCRYPTION_KEY_PREVIOUS`、`LOG_LEVEL`、`LOG_FORMAT`、`METRICS_ADDRESS`、`SHUTDOWN_GRACE_SECONDS` 在 `app.go`、`.env.example`、两份 compose、README 表格均存在 |
| `legacy-node-api` 标签 | 指向 `7608911`，即删除前的 `main`，正确。**标签与分支都还没有推到 origin** |

按计划第 8 节的重点逐项：

- **A1 残留直连代码**：`apiKey|Bearer|x-goog-api-key` 只剩管理后台渠道页的字段名；`openConfigDialog|isAiConfigReady|useEffectiveConfig|channelMode|withLocalProxy|webdav|AppConfigModal|guessCapability` 为空。`prompt-source*` 按计划保留。通过。
- **A2**：`git ls-files api canvas-proxy render.yaml vercel.json web/vercel.json web/bun.lock canvas-agent/bun.lock` 为空；`` `api/` `` 只剩指向标签的句子；render 引用为空；bun 命令只剩文档站自身；`.dockerignore` 与计划逐行一致。通过。`web/tests/image-thumbnail.test.ts` 在最终 HEAD 存在，是 D1 新写的 vitest 版本（A2 已删掉 bun:test 版），不算遗漏。
- **C1 视图替换**：`auto_disabled_at IS NULL` 在非测试代码中已无手写判定；`available_model_channels` 在 content.go、generation.go、worker.go 共 6 处引用；`monitoring.go:379` 与 `ops.go:155` 的 `status='active' AND deleted_at IS NULL` 是检测调度用的另一种语义，不替换是对的。通过。
- **C7/C8 是否影响结算退款**：`cancelTask` 的退款事务未改，只在提交后追加广播；worker 里取消分支在 `finishTask` 之前 `return`，且 `finishTask` 本身有 `status='running' AND worker_token` 守卫；退出分支走 `requeue` 不经过结算。`wallet.go`、`pricing.go` 的改动只有加二次验证与频控。两个专项测试我复跑通过。通过。
- **D6 拆分行为回归**：三个 hook 抽出后 65 个用例通过，恢复逻辑的三个测试锚点已迁移。画布交互仍需按 pending-test 人工回归。

## 2. 需要返工（合并前必须处理）

### R1 C15 引入回归：管理后台「启用/禁用用户」接口被打坏，且伪造的二次验证会放行

位置：`server/internal/platform/admin.go:138-175`。`status` 与 `role` 两个 PATCH 共用一个循环和一个请求体结构，结构里嵌了 `SecurityProof securityProof`，而 `securityProof.Password` 带 `binding:"required"`（`security.go:24-27`）。gin 对嵌套结构同样执行校验，于是：

- 前端 `updateAdminUserStatus`（`web/src/services/api/admin-users.ts:23`）只发 `{ status }`，后端在绑定阶段就返回 400 `invalid_request`。管理员在用户页点「禁用/启用」必然失败。
- 反过来，请求体里塞一个任意的 `securityProof.password`，`status` 分支不会调用 `requireSecurityProof`，请求 200 且状态被改掉。

我用真实数据库跑了探针（管理员 Cookie 调 `PATCH /api/admin/users/:id/status`）：不带 proof 返回 400；带 `password:"x"` 返回 200 且库里 `status=disabled`。现有测试没有覆盖这个接口，所以 70 个用例全绿也没拦住。

建议修法（任选其一，都不需要动 `securityProof` 结构以免影响 `security.go` 里既有 4 个接口）：
1. 把该结构里的字段改成指针 `SecurityProof *securityProof`，`role` 分支里 `nil` 即返回 `security_proof_required`，再解引用交给 `requireSecurityProof`；`status` 分支不读它。
2. 或者把循环拆开，`status` 路由用只含 `Status` 的请求体。

同时补一个测试：`status` 不带 proof 应 200，`role` 不带 proof 应 400 且角色不变。

### R2 C9 引入回归：文本 SSE 只在收到 `changed` 信号时查库，但有三条状态变化从不发信号

位置：`server/internal/platform/text_stream.go:120-199`。改动前每 2.5 秒必查一次 `textRequestDetail`，任何状态变化 2.5 秒内都会推给客户端；改动后只有 `publishText` 触发的 `changed` 才查库。全仓库调用 `publishText` 的地方只有 `appendText`（每个 delta）与 `finishTask`。下面三处改状态但不发信号：

| 位置 | 状态变化 | 客户端表现 |
| :--- | :--- | :--- |
| `moderation.go:71` 审核决定 | 拒绝：`reviewing → failed` 并退款 | 文本页停在「等待内容审核」直到用户手动刷新，改动前 2.5 秒内更新。通过：`reviewing → queued`，要等 worker 拿到第一个 token 才有推送，中间「正在等待可用渠道」提示看不到 |
| `generation.go:378` `cancelTask` | `→ canceled` | 文本页自己会 `refetch`，界面正常；但会话删除接口（`text.go:104`）联动取消时，正在看该会话的另一个标签页收不到推送 |
| `worker.go:639` `retryTask` / `worker.go:628` `requeue` | `running → queued`，`attempt_count+1` | 快照 key 含 `attemptCount`，改动前会推一次让前端显示「正在切换渠道」，现在不推 |

前端 `watchTextRequest`（`web/src/services/api/text.ts`）没有超时兜底，EventSource 收不到快照就一直挂着。

建议修法：
1. 在上述三处事务提交后调用 `a.publishText(ctx, taskID)`（`cancelTask` 只对 `capability='text'` 发；`retryTask` 在 `RowsAffected()==1` 时发；审核决定对每个 text 任务发）。
2. 再加一层兜底：`textEvents` 里每 30 秒的会话校验 tick 顺带把 `refresh` 置 true，多实例下 Redis 丢消息也能在 30 秒内自愈。
3. 补测试：审核拒绝后 SSE 应在一次心跳内收到 `failed` 快照。

## 3. 接受执行方的偏离与决定

- **保留 `shadcn` 依赖**：我核对 `web/src/components/ui/select.tsx` 确实用了 `data-open:` 变体，删掉 `@import "shadcn/tailwind.css"` 会破坏动效。接受。
- **`grep basketikun` 无法为空**：剩余三处（插件 registry 默认值、GitHub 链接、`npx @basketikun/canvas-agent` 文案）都在计划 5.1 禁改范围内，是计划验收标准写宽了。接受。
- **C1 未替换 `admin.go` 绑定列表与 `public_status.go` 三态计算**：语义不同，判断正确。
- **C11 补服务端筛选、D9 补 `keyword`/`kind`**：分页后必须服务端筛选，是正确的顺手修正。
- **C17 越权断言按实际实现返回 404**、**D4 `LogCard` 增加 `variant`**、**D7 拆出 4 个 hook**、**D6 文本恢复改为 SSE**：都有合理说明且有测试覆盖。接受。
- **未完成 4 项**（D6 第 4、5 步；D8 画布部分；D9 虚拟滚动）：理由成立。`project.tsx` 3388 行、`CanvasNode` 38 个 props，下一轮继续。

## 4. 待项目所有者决定（不阻塞合并）

1. **`canvas-save` 频控 120 次/分钟**：画布内容保存 debounce 1 秒（`use-canvas-store.ts:68`）、视口保存另走 3 秒 debounce，单标签页理论上限约 80 次/分钟；同时开多个画布标签页可能触顶。触顶后 store 会按退避重试，不丢数据，但建议放宽到 300 或把视口保存排除在频控外。
2. **`SHUTDOWN_GRACE_SECONDS` 默认 30 秒与 Docker 默认 `stop_grace_period` 10 秒不匹配**：compose 下容器会在 10 秒被 SIGKILL，在途任务来不及重排，仍会走 480 秒后的超时恢复。需要在 compose 的 `api` 服务加 `stop_grace_period: 40s`，这属于部署范围（计划规则 11 之外），建议放到下一轮部署文档里。
3. **C12 请求级 60 秒时限**：`POST /api/admin/channels/:id/models`（拉取上游模型列表，`admin.go:702`）不在豁免表里，慢上游会在 60 秒返回 504，而渠道自身超时默认 300 秒。建议加入 `slowRoutes`。
4. **报告中的数字**：CHANGELOG 实际新增 20 条（报告写 22 条）；不影响内容。

## 5. 合并前的操作清单

1. ~~执行方修复 R1、R2 并补测试~~ 已由审查方完成，见第 6 节。
2. 推送标签：`git push origin legacy-node-api`。文档里已经把它当归档入口，标签不在远端就是悬空引用。
3. 推送分支并合并：`git push origin improvement/round-1`。
4. 按 `docs/content/docs/progress/pending-test.zh-CN.mdx`「第一轮改进」小节做人工验收，重点是画布交互回归、密钥轮换全流程、二次验证弹窗、用户启用/禁用、审核与取消后的文本页状态推送。
5. 测试容器用完后清理：`docker rm -f ic-test-pg ic-test-redis ic-test-minio`。

## 6. 审查方修复记录（2026-09-22）

在 `improvement/round-1` 上追加提交，均已用带数据库的 `go test -count=1 ./...` 验证：

| 项 | 改动 | 验证 |
| :--- | :--- | :--- |
| R1 | `admin.go` status/role PATCH 的 `securityProof` 改为指针，`status` 分支不再受嵌套 `required` 影响；`role` 分支 `nil` 时返回 `security_proof_required`；审计详情改为只记 `{field: 值}`，不再把整个请求体（含管理员密码）写入 `audit_logs` | 新增 `TestUserStatusPatchDoesNotRequireSecurityProof`；先在未修复代码上跑，确认 400 复现，修复后通过 |
| R2 | `moderation.go` 审核决定提交后对 text 任务 `publishText`；`generation.go` `cancelTask` 对 text 任务 `publishText`；`worker.go` `requeue`/`retryTask` 成功后对 text 任务 `publishText`；`text_stream.go` 每 30 秒会话校验时强制 `refresh = true` 兜底 | 新增 `TestTextSSEReceivesModerationAndCancelTransitions`（审核拒绝 → `failed`、取消 → `canceled` 均在一次心跳内收到快照）；先在未修复代码上跑，确认超时复现，修复后通过 |
| 第 4 节 1 | `canvas-save` 频控 120 → 300 次/分钟 | 数值变更，CHANGELOG 与待测试清单已同步 |
| 第 4 节 2 | 两份 compose 的 `api` 服务加 `stop_grace_period: 40s`，README 该行注明必须大于 `SHUTDOWN_GRACE_SECONDS` | `docker compose config` 解析通过 |
| 第 4 节 3 | `/api/admin/channels/:id/models` 加入 `slowRoutes` | 编译通过 |

审计详情不写请求体这一点，同样适用于 `wallet.go:334` 的 `invitation.status`（原代码就如此，无凭据字段，本次未改）。
