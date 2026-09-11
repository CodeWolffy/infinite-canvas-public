# 构建 Vite 前端产物。
FROM node:24-alpine AS web-build

WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
# 现有 Pro Components beta 的 peer 声明仍停留在 antd 5，保留项目已采用的 antd 6 组合。
RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN npm run build

# 运行镜像：由 Nginx 提供静态前端，并把 /api 与 /health 反向代理到 API 容器。
FROM nginx:1.27-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 3000
