# 无限画布文档索引

- [Go 公益平台：架构、支付、边界配置与部署](public-platform.md) — 当前分支的运行说明；原 `api/` 与企业版文档保留为参考。

## 项目介绍

- [快速开始](/zh-CN/docs/overview/quick-start)
- [功能介绍](/zh-CN/docs/overview/features)
- [Render 部署](/zh-CN/docs/overview/render)
- [Docker 部署](/zh-CN/docs/overview/docker)
- [第三方提示词来源](/zh-CN/docs/overview/third-party-prompt-repositories)

## 操作手册

- [画布节点操作手册](/zh-CN/docs/canvas/canvas-node-manual)
- [画布快捷键](/zh-CN/docs/canvas/canvas-shortcuts)

## 开发与数据

- [本地开发](/zh-CN/docs/development/local-development)
- [画布数据结构](/zh-CN/docs/development/canvas-data-structure)

## 商务合作

- [开源协议](/zh-CN/docs/business/license)
- [商务合作](/zh-CN/docs/business/business)

## 支持与安全

- [漏洞提交](/zh-CN/docs/support/security)
- [赞助支持](/zh-CN/docs/support/sponsor)

## 项目进度

- [更新日志](/zh-CN/docs/progress/changelog)
- [公司内部创作平台二开规划](/zh-CN/docs/progress/internal-platform-plan)
- [Go 后端能力与 new-api 对照](backend-capability-review.md)
- [待测试](/zh-CN/docs/progress/pending-test)
- [TODO](/zh-CN/docs/progress/todo)

## 说明

- 当前内部平台实现已进入待测试：画布、素材、图片记录和文本结果以 PostgreSQL 与 MinIO 为权威来源。
- AI API Key 由管理员配置并加密保存在服务端，普通用户的图片与文本请求通过平台渠道发送。

## 原理说明

- [本地 Codex 连接画布原理](/zh-CN/docs/development/local-codex-canvas)
