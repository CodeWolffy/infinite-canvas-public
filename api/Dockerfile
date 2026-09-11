FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/tsconfig.json api/drizzle.config.ts ./
COPY api/src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY api/drizzle ./drizzle

EXPOSE 3001
CMD ["node", "dist/index.js"]
