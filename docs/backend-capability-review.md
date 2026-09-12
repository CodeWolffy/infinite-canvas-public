# Go 后端能力与 new-api 对照

当前已补充渠道自动故障转移、多 Key、检测自动停用恢复、Claude Messages、耗时统计、公开模型状态、人工审核、可选邀请奖励和用户文本对话。周期赠送与周期消费额度已移除，用户余额、签到、邀请奖励及兑换到账永久保留。本机 Docker 构建与启动、44 组后端测试、52 项前端回归及 7 组隔离接口验收已通过；下方早期测试记录作为基线保留。平台业务部署入口仍为 `server/` Go 服务。

## 已完成的能力

| 能力 | 当前实现 | 主要源码 |
| --- | --- | --- |
| 渠道健康与告警 | 手动/周期生成检测，模型变更，余额提醒，故障及恢复通知；共享渠道槽位与冷却；站内通知与一次邮件投递，检测中断不重放原请求 | [monitoring.go](../server/internal/platform/monitoring.go)、[notifications.go](../server/internal/platform/notifications.go) |
| 账号安全 | 验证邮箱、一次性密码找回链接、TOTP 第二步登录、一次性恢复码、设备与会话撤销；密钥加密、凭证哈希保存、防重放 | [security.go](../server/internal/platform/security.go)、[auth.go](../server/internal/platform/auth.go) |
| 文本流式 | OpenAI/Gemini 上游流式，持久化片段、SSE 推送、断线读取快照、正式消息去重；工作台和画布显示进度，换账号关闭旧订阅 | [text_stream.go](../server/internal/platform/text_stream.go)、[text.ts](../web/src/services/api/text.ts) |
| 分组权限与永久余额 | 分组限制可用模型，列表/报价/创建/重试/执行均校验；余额、签到、邀请与兑换到账永久保留，保留可选存储配额，移除周期规则 | [group_policy.go](../server/internal/platform/group_policy.go)、[groups.go](../server/internal/platform/groups.go)、[ops.go](../server/internal/platform/ops.go) |
| 成本与透明报价 | 创建、重试与服务端报价共用价格快照；用户实付与上游成本分开，成本来源区分未知/配置估算/人工核对；成本账独立于可清理日志，支持时间与来源筛选 | [pricing.go](../server/internal/platform/pricing.go)、[costs.go](../server/internal/platform/costs.go) |

配置入口和已确认的默认规则见 [Go 平台运行说明](public-platform.md)。自动检测与邀请奖励默认关闭，任务默认最多尝试 3 次；邮件功能须先配置 SMTP，管理员验证邮箱后才接收邮件告警。音频按秒结算需要 ffprobe，Dockerfile 已声明安装，本地 Go 开发需将其加入 PATH。

## 已修复的问题

| 原问题 | 修复后的行为 |
| --- | --- |
| 实际 token 费用超过冻结额重复补扣 | 结算只写一次差额；余额不足时沿用冻结额封顶，计算费用、实际扣款和账本一致对应 |
| 零缓存单价被当成未配置 | `NULL` 采用输入单价，显式 `0` 保持免费 |
| 后台秒价未保存，字符串时长未识别 | 完整保存秒价，数值/字符串时长按同一规则处理；视频按请求时长，音频按 ffprobe 读取的实际时长结算 |
| 重试遗漏分组折扣 | 重试按当前模型、分组和时长重新生成价格快照 |
| 一个用户只能兑换一个充值码 | 移除用户单列唯一约束，保留用户与充值码联合唯一约束 |
| 敏感词“仅记录”实际拦截 | 放行并记录匹配规则、用户和处理方式，不记录完整提示词；后台可查看最近命中 |
| 工作台仅展示固定单次价 | 展示适用计价方式、服务端预冻结额和最终实付 |

补扣不足时封顶冻结额属于保留的既有政策，可能产生平台承担的费用；成本页面只对已知成本作差额统计，未知成本不能视为零，配置估算不能替代上游真实账单。

## 数据与验证

新增结构通过 [012_channel_routing.sql](../server/migrations/012_channel_routing.sql) 和 [013_moderation_and_rewards.sql](../server/migrations/013_moderation_and_rewards.sql) 按现有流程升级，不迁移公司数据库；已有加密 Key 转入独立表，移除周期规则字段，保留钱包、签到、历史领取记录和账本。需同步更新 Go 与 Web。

此前基线的 30 组后端测试和 52 项前端回归通过，覆盖实际余额变化、并发领取、权限绕过、重复兑换、MFA/链接重放、设备撤销、流式中间态与最终结算、跨会话丢弃、监测通知去重、费用记录保留、真实音频时长和探测器网络隔离。主要用例位于 [operations_test.go](../server/internal/platform/operations_test.go)、[capabilities_test.go](../server/internal/platform/capabilities_test.go)、[text-stream.test.cjs](../web/tests/text-stream.test.cjs)。

浏览器使用独立 PostgreSQL、Redis、MinIO 和本地模拟上游验收；文本示例预冻结 ¥0.008456，最终实扣 ¥0.000039，余额、正式回复和成本页面一致。生产构建、Docker 镜像构建、真实 SMTP、真实商户支付、真实上游与目标硬件性能不在本轮验证范围，继续按[待测试清单](content/docs/progress/pending-test.zh-CN.mdx)验收。

## new-api 参考与本轮边界

对照的是工作区本地 `new-api/` 源码快照。该目录没有独立 Git 元数据，不能把宿主仓库 HEAD 当作其上游版本；它不参与平台部署。

主要参考入口：SSE 的 `new-api/relay/channel/openai/relay-openai.go`，账号安全的 `controller/twofa.go` 和 `controller/auth_session.go`，渠道检测的 `controller/channel-test.go`，通知的 `service/user_notify.go`，分组能力的 `model/ability.go`；本项目不采用周期额度。本项目继续使用自己的持久化任务、人民币账本、画布和素材权限。

即梦、可灵、Vidu、原生 Sora、Suno 尚待实际供应商接口文档，目前仅保留待接入入口；音乐能力未开放。对外 API Key、完整套餐体系与管理员权限细分仍需另行明确场景。
