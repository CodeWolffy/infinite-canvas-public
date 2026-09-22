# 无限画布 · AI 创作平台 (Infinite Canvas)

<p align="center">
  <strong>面向多模态创作的统一 AI 工作台与无限画布</strong>
</p>

<p align="center">
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.26+-00ADD8?style=flat-square&logo=go" alt="Go Version" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react" alt="React 19" /></a>
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql" alt="PostgreSQL" /></a>
  <a href="https://redis.io/"><img src="https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis" alt="Redis" /></a>
  <a href="https://min.io/"><img src="https://img.shields.io/badge/MinIO-Object_Storage-C72C48?style=flat-square&logo=minio" alt="MinIO" /></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker" alt="Docker" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#-核心特性">✨ 核心特性</a> ·
  <a href="#️-技术架构">🛠️ 技术架构</a> ·
  <a href="#-快速开始">🚀 快速开始</a> ·
  <a href="#️-关键配置说明">⚙️ 关键配置</a> ·
  <a href="#-项目结构">📁 项目结构</a> ·
  <a href="#-文档与支持">📖 详细文档</a>
</p>

---

## 📖 项目简介

**无限画布（Infinite Canvas）** 是一套开箱即用的多模态 AI 统一创作平台。系统深度整合「节点式无限画布」与「独立生成工作台」，支持图片、视频、文本对话以及音频等全模态内容的生成、流转与服务端持久化管理。

平台基于现代前后端分离架构构建，前端采用 **React 19 + TypeScript + Vite + Ant Design**，后端采用高性能 **Go (Gin + pgx)**。平台内置了多渠道智能路由调度、两阶段事务级账务体系（预冻结/按需结算/失败退还）、内容安全过滤与审核机制，以及完善的邀请与运营体系，让个人与团队无需自行维护各厂商 API Key，即可低门槛、高可靠地开展 AI 创作。

---

## ✨ 核心特性

### 🎨 沉浸式无限画布 (Infinite Canvas)
- **自由节点编排**：支持文本、图像、音视频及配置节点的自由拖拽、无级缩放与任意布局。
- **媒体流转串联**：节点生成产物可一键作为下游节点的输入或参考图，构建直观的可视化创作流。
- **断点恢复续查**：画布状态与服务端异步长任务实时同步，页面刷新或更换设备均可无缝恢复进度。

### ⚡ 全模态生成工作台 (Multi-modal Studio)
- **图像创作**：支持文生图、图生图、参数预设与画质控制，服务端持久化保存生成历史与资产。
- **文本对话**：基于 SSE 全双工流式回复，提供模型切换与思考强度（Reasoning Effort）调节，严格按会话隔离历史上下文。
- **视频与音频**：统一的任务适配器支持异步队列调度、进度轮询、状态回调与自动转存。

### 🔀 智能渠道调度与容灾 (Channel Routing & HA)
- **多 Key 轮询与负载分流**：单渠道支持多 API Key 轮询（Round-Robin）或随机调度，避免单 Key 配额超限。
- **优先级与权重分流**：支持按渠道优先级分层与同层权重调度，灵活实现流量按需分配与成本优化。
- **健康探活与故障转移**：内置健康探针，连续失败自动熔断；遇上游瞬时故障自动无感重试候选渠道。

### 💰 严密账务与灵活定价 (Billing & Financial Ledger)
- **两阶段事务级账本**：任务创建时原子预冻结额度，完成时按实际消耗多退少补，失败或取消全额退款。
- **多维计费规则**：支持按次、按时长（秒）、按 Token（细分输入、缓存命中与输出 Token）独立定价，支持用户组折扣。
- **多通道支付与运营工具**：集成微信支付 Native v3、支付宝官方当面付与易支付协议；内置每日签到奖励、兑换码批量生成/导出与好友充值返利。

### 🛡️ 安全合规与运营风控 (Security & Management)
- **凭据全程脱敏落库**：上游渠道 API Key 由服务端 AES 密钥加密落库，绝不下发至客户端浏览器。
- **内容安全与风控审核**：提示词全局敏感词检测，支持直接拦截（Block）、人工审核队列（Review）与日志审计。
- **账户与频控保护**：Argon2id 密码哈希、TOTP 两步验证（2FA）、跨实例账号/IP 频控限制与防重点击保护。

---

## 🛠️ 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                    前端应用 (Web Client)                     │
│        React 19 + TypeScript + Vite + Ant Design 6          │
└──────────────┬───────────────────────────────▲──────────────┘
               │ HTTP / SSE                    │ Media URL
               ▼                               │
┌──────────────────────────────────────────────┴──────────────┐
│                    API 服务 (Go Backend)                     │
│         Gin Web 框架 + pgx 原生驱动 + AES 凭据加密           │
├─────────────────┬────────────────────────────┬──────────────┤
│  渠道调度与探活   │    两阶段任务调度与账务     │  内容审核与风控│
└────────┬────────┴────────────┬───────────────┴───────┬──────┘
         │                     │                       │
         ▼                     ▼                       ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  PostgreSQL 17  │   │     Redis 7     │   │      MinIO      │
│  权威数据与账本  │   │  频控与并发槽位 │   │  私有媒体对象云 │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

- **Web 前端**：React 19、TypeScript、Vite、Tailwind CSS、Ant Design 6、Zustand、React Router 7。
- **后端服务**：Go 1.26、Gin、pgx/v5、argon2id、pquerna/otp。
- **数据与存储**：PostgreSQL 17（权威业务与不可变流水）、Redis 7（分布式频控与并发控制）、MinIO（对象存储）。
- **容器编排**：Docker & Docker Compose 一键拉起完整运行环境。

---

## 🚀 快速开始

本项目支持通过 Docker Compose 快速启动运行。

### 前置要求
- 已安装 [Docker](https://docs.docker.com/get-docker/) 及 [Docker Compose](https://docs.docker.com/compose/)。
- 确保宿主机网络可正常拉取基础镜像。

---

### 方案一：本地快速运行 (推荐体验)

适合在本地开发机快速体验完整功能：

1. **克隆项目源码**
   ```sh
   git clone https://github.com/CodeWolffy/infinite-canvas-public.git
   cd infinite-canvas-public
   ```

2. **准备环境变量**
   ```sh
   cp .env.example .env.local
   ```
   > 提示：本地模式默认占用 `3301` 宿主机端口。若端口冲突，可在 `.env.local` 中修改 `PUBLIC_WEB_PORT`。

3. **启动容器服务**
   ```sh
   docker compose --env-file .env.local -f docker-compose.local.yml up -d --build
   ```

4. **进入控制台**
   - 浏览器打开 [http://localhost:3301](http://localhost:3301)。
   - 使用初始管理员账号登录（默认密码详见 `.env.local` 中的 `BOOTSTRAP_ADMIN_PASSWORD`）。
   - 进入管理后台，配置模型渠道、定价规则即可开始创作。

---

### 方案二：服务器生产部署

适合部署在 Linux 服务器环境：

1. **拉取代码并配置环境**
   ```sh
   git clone https://github.com/CodeWolffy/infinite-canvas-public.git
   cd infinite-canvas-public
   cp .env.example .env
   ```
   编辑 `.env` 文件，按实际生产环境修改配置：
   - 设置高强度 `POSTGRES_PASSWORD`、`REDIS_PASSWORD`、`MINIO_ROOT_PASSWORD`。
   - 生成并填写至少 32 位的强随机字符串作为 `CHANNEL_ENCRYPTION_KEY`。
   - 填写生产公网域名，例如 `PUBLIC_URL=https://your-domain.com`。

2. **启动生产容器**
   ```sh
   docker compose up -d --build
   ```

3. **配置反向代理 (Nginx / 1Panel)**
   生产环境推荐在前端加设 Nginx 统一处理 HTTPS 证书与静态转发。反代宿主机 `127.0.0.1:3000` 即可：
   ```nginx
   server {
       listen 443 ssl http2;
       server_name your-domain.com;

       ssl_certificate /path/to/fullchain.pem;
       ssl_certificate_key /path/to/privkey.pem;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto https;
           proxy_buffering off;
           proxy_read_timeout 300s;
       }
   }
   ```

4. **版本平滑更新**
   ```sh
   git pull origin main
   docker compose up -d --build
   ```

---

## ⚙️ 关键配置说明

系统所有核心配置均集中在环境变量中，以下是主要配置参数对照表：

| 配置项 | 示例/默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PUBLIC_URL` | `http://localhost:3301` | 平台对外公开的基础 URL（包含协议与域名） |
| `PUBLIC_WEB_PORT` | `3301` | 本地 Compose 映射到宿主机的 Web 端口 |
| `CHANNEL_ENCRYPTION_KEY` | *(至少 32 位随机字符串)* | **至关重要**：用于加密保存渠道 API 密钥的 AES 密钥，必须离线备份 |
| `CHANNEL_ENCRYPTION_KEY_PREVIOUS` | *(留空)* | 仅密钥轮换期间设置，填上一把主密钥；轮换完成后必须移除 |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | 系统初次初始化时的管理员账号 |
| `BOOTSTRAP_ADMIN_PASSWORD` | *(初始化密码)* | 系统初次初始化时的管理员密码，初次登录后建议修改 |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | PostgreSQL 权威数据库连接串 |
| `REDIS_URL` | `redis://:pass@host:6379/0` | Redis 实例连接串，用于跨实例频控与渠道并发控制 |
| `WORKER_CONCURRENCY` | `50` (默认 20) | 本机异步生成与流式任务并发协程工作池上限（兼顾图文音视所有类型） |
| `TRUST_PROXY` | `true` (生产) / `false` (本地) | 是否信任反向代理传递的 `X-Forwarded-*` 标头 |
| `LOG_LEVEL` | `info` | 日志级别，可选 `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `text` | 日志格式，可选 `text` / `json` |
| `METRICS_ADDRESS` | *(留空即关闭)* | Prometheus 指标与 pprof 监听地址（如 `:9090`）；只在内网使用，不要映射到公网 |

### 轮换渠道加密密钥

渠道密钥、支付配置、SMTP 密码、TOTP 密钥与任务渠道快照都由 `CHANNEL_ENCRYPTION_KEY` 加密。轮换步骤：

1. 在 `.env` 中设置 `CHANNEL_ENCRYPTION_KEY_PREVIOUS=<旧密钥>`，并把 `CHANNEL_ENCRYPTION_KEY` 改成新密钥。
2. 重启服务：`docker compose up -d api`。
3. 执行重加密：`docker compose exec api canvas-server rotate-keys`，确认输出中各表行数符合预期。
4. 从 `.env` 移除 `CHANNEL_ENCRYPTION_KEY_PREVIOUS`，再次重启。

轮换期间新写入的密文带 `v1:` 前缀，只能用新密钥解开；没有前缀的旧密文会先用新密钥、再用上一把密钥尝试解密。重加密按表分批执行，任一记录解密失败会整表回滚，旧密钥不会被提前废弃。

---

## 📁 项目结构

```
infinite-canvas-public/
├── web/                     # 前端工程
│   ├── src/
│   │   ├── components/      # UI 组件库与画布交互组件
│   │   ├── pages/           # 页面路由（画布、工作台、管理后台、设置等）
│   │   ├── stores/          # 全局状态管理 (Zustand)
│   │   └── services/        # 统一 API 接口通信层
│   └── package.json
├── server/                  # 后端 Go 平台
│   ├── main.go              # 服务启动入口与路由注册
│   ├── internal/platform/   # 核心业务实现（鉴权、渠道、任务调度、账务、审核）
│   ├── migrations/          # PostgreSQL 增量数据库迁移脚本
│   └── go.mod
├── docs/                    # 完整设计规范与技术文档
├── docker-compose.yml       # 生产环境容器编排
├── docker-compose.local.yml # 本地开发/体验容器编排
├── .env.example             # 环境变量配置模板
└── README.md
```

---

## 📖 文档与支持

- 📘 **[平台架构与部署详细说明](docs/public-platform.md)**：包含渠道调度机制、支付回调接入、两阶段账务详解与配置边界。
- 📑 **[AI 与开发文档索引](docs/index.md)**：包含完整文档目录导航。
- 📋 **[待测试清单](docs/content/docs/progress/pending-test.zh-CN.mdx)**：当前版本测试进度与待验证项。
- 📝 **[项目后续待办](docs/content/docs/progress/todo.zh-CN.mdx)**：长期规划与功能演进路线。
- 🏷️ **[版本变更记录](CHANGELOG.md)**：历史版本特性更新日志。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 许可协议。

