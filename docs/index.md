# Infinite Canvas Documentation Index

- [Go 公益平台：架构、支付、边界配置与部署](public-platform.md) — 当前分支的运行说明；原 `api/` 与企业版文档保留为参考。

## Overview

- [Quick Start](/docs/overview/quick-start)
- [Features](/docs/overview/features)
- [Deploy on Render](/docs/overview/render)
- [Docker Deployment](/docs/overview/docker)
- [Third-party Prompt Sources](/docs/overview/third-party-prompt-repositories)

## Canvas Guide

- [Canvas Node Guide](/docs/canvas/canvas-node-manual)
- [Canvas Shortcuts](/docs/canvas/canvas-shortcuts)

## Development and Data

- [Local Development](/docs/development/local-development)
- [Canvas Data Structure](/docs/development/canvas-data-structure)
- [How the Local Codex Connection Works](/docs/development/local-codex-canvas)

## Business

- [Open-source License](/docs/business/license)
- [Business Cooperation](/docs/business/business)

## Support and Security

- [Report a Vulnerability](/docs/support/security)
- [Sponsor the Project](/docs/support/sponsor)

## Project Progress

- [Changelog](/docs/progress/changelog)
- [Internal Creative Platform Plan](/docs/progress/internal-platform-plan)
- [Enterprise API Review](enterprise-api-review.md)
- [Go Backend Capability Review against new-api](backend-capability-review.md)
- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Notes

- The internal-platform implementation is pending verification; canvases, assets, image history, and text results now use PostgreSQL and MinIO as authoritative storage.
- Administrators configure encrypted server-side channel API keys, and regular users send image and text requests through the platform.
- The deployment uses a public HTTPS domain through 1Panel and the Web Nginx proxy, with source ports closed to the Internet. Local Codex remains an optional per-user integration, independent of platform text models.
