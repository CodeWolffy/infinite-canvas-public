import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { minio } from "./media.js";
import { adminChannelRoutes } from "./routes/admin-channels.js";
import { adminModelRoutes } from "./routes/admin-models.js";
import { adminRequestLogRoutes } from "./routes/admin-request-logs.js";
import { adminStatsRoutes } from "./routes/admin-stats.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { assetRoutes } from "./routes/assets.js";
import { authRoutes } from "./routes/auth.js";
import { canvasProjectRoutes } from "./routes/canvas-projects.js";
import { generationBatchRoutes } from "./routes/generation-batches.js";
import { mediaRoutes } from "./routes/media.js";
import { modelRoutes, preferenceRoutes } from "./routes/models.js";
import { textRoutes } from "./routes/text.js";
import { userCenterRoutes } from "./routes/user-center.js";

export function buildApp() {
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers.set-cookie",
          "body.password",
          "body.currentPassword",
          "body.newPassword",
          "body.temporaryPassword",
          "body.apiKey",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.TRUST_PROXY,
    ignoreTrailingSlash: true,
    // 画布快照是普通 JSON 体，默认 1MB 上限会让大画布保存直接失败，这里与上传上限对齐。
    bodyLimit: config.MAX_UPLOAD_BYTES,
  });

  app.register(cookie);
  app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
  });
  app.register(multipart, {
    limits: { files: 1, fileSize: config.MAX_UPLOAD_BYTES },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let sameOrigin = false;
    try {
      const parsed = new URL(origin);
      sameOrigin = parsed.origin === origin && ["http:", "https:"].includes(parsed.protocol) && parsed.host === request.headers.host;
    } catch {}
    if (!sameOrigin && !config.CORS_ORIGINS.includes(origin)) {
      return reply.code(403).send({ error: "invalid_origin", message: "请求来源不受信任" });
    }
  });

  // 注入基础安全响应头，防御 MIME 嗅探、点击劫持与跨源信息泄露
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  });

  app.get("/health", async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      await minio.bucketExists(config.MINIO_BUCKET);
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.register(authRoutes, { prefix: "/api/auth" });
  app.register(userCenterRoutes, { prefix: "/api/user" });
  app.register(canvasProjectRoutes, { prefix: "/api/canvas-projects" });
  app.register(generationBatchRoutes, { prefix: "/api/generation-batches" });
  app.register(textRoutes, { prefix: "/api/text" });
  app.register(assetRoutes, { prefix: "/api/assets" });
  app.register(modelRoutes, { prefix: "/api/models" });
  app.register(preferenceRoutes, { prefix: "/api" });
  app.register(adminUserRoutes, { prefix: "/api/admin/users" });
  app.register(adminModelRoutes, { prefix: "/api/admin/models" });
  app.register(adminChannelRoutes, { prefix: "/api/admin/channels" });
  app.register(adminRequestLogRoutes, { prefix: "/api/admin/request-logs" });
  app.register(adminStatsRoutes, { prefix: "/api/admin/stats" });
  app.register(mediaRoutes, { prefix: "/api/media" });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "请求参数不正确",
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : error && typeof error === "object" && "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause
        ? String(error.cause.code)
        : undefined;
    if (code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({ error: "file_too_large", message: "图片超过上传大小限制" });
    }
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: "payload_too_large", message: "请求数据过大，无法保存" });
    }
    if (code === "23505") {
      return reply.code(409).send({ error: "conflict", message: "数据已存在" });
    }
    if (code === "23503") {
      return reply.code(409).send({ error: "in_use", message: "数据仍被其他记录引用" });
    }
    const cause = error instanceof Error ? error : new Error(String(error));
    app.log.error({
      name: cause.name,
      code,
      message: cause.message,
      stack: cause.stack,
    });
    return reply.code(500).send({ error: "internal_error", message: "服务暂时不可用" });
  });

  return app;
}
