# 无限画布 · 公益创作平台

为有图片、视频、文本和音频创作需求的用户提供统一工作台与无限画布。管理员配置模型和上游渠道，用户通过邀请注册，签到领取人民币余额，也可按需充值，无需自行配置 API Key。

## 核心功能

- 图片、视频、文本、音频生成，任务与历史保存在服务端。
- 无限画布、媒体素材、任务续查和个人用量记录。
- 邀请注册、用户管理、模型定价、渠道优先级与权重调度。
- 管理员配置随机签到奖励，人民币余额冻结、结算与失败退款。
- 易支付兼容接口、支付宝官方当面付、微信 Native API v3。
- Go + PostgreSQL + Redis + MinIO，支持跨实例频控和渠道并发控制。

## 快速开始

准备 Docker Compose。公网服务器项目根目录使用 `.env` 保存生产配置；本机公益平台使用单独的 `.env.local`，不要与公司项目的配置文件混用：

若在本机运行，可复制 `.env.example` 为 `.env.local` 并填写本地密钥；生产服务器在 `/opt/infinite-canvas-public/.env` 保存独立生产密钥。本地 Compose 默认使用 `infinite-canvas-public` 项目名和 `3301` 宿主机端口，避免与公司项目的 `infinite-canvas` / `3300` 组合混用。

```sh
docker compose --env-file .env.local -f docker-compose.local.yml up -d --build
```

打开 [本机平台](http://localhost:3301)，使用初始化管理员登录并修改初始密码，然后配置渠道、模型、签到与邀请码。若 `3301` 已被占用，可在 `.env.local` 中设置 `PUBLIC_WEB_PORT`，例如 `3302`。

公网首次部署：

```sh
cd /opt
git clone https://github.com/CodeWolffy/infinite-canvas-public.git
cd /opt/infinite-canvas-public
cp .env.example .env
# 编辑 .env，填写公网域名、数据库密码、MinIO 密码、加密密钥和管理员密码
docker compose up -d --build app api
```

公网后续更新：

```sh
cd /opt/infinite-canvas-public
git pull origin main
docker compose up -d --build app api
```

生产配置固定保存在服务器项目根目录 `.env`，不提交 Git。Go 平台使用独立空数据库，不覆盖公司版数据。支付实际可用性取决于商户配置和联调结果，生产静态资源路径及吞吐量仍需验收。

## 文档

- [架构、支付配置、默认边界和部署说明](docs/public-platform.md)
- [AI 文档索引](docs/index.md)
- [待测试清单](docs/content/docs/progress/pending-test.zh-CN.mdx)
- [后续事项](docs/content/docs/progress/todo.zh-CN.mdx)
- [版本变更](CHANGELOG.md)

沿用 Infinite Canvas 的画布界面与本地 Agent 集成。原 TypeScript `api/` 和本地 `new-api/` 源码仅作参考，生产后端为 `server/`。开源许可见 [LICENSE](LICENSE)。
