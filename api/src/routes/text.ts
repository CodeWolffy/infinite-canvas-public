import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { hasChannelCandidates, runWithFailover, UpstreamError } from "../channel-scheduler.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  assets,
  canvasProjectMedia,
  canvasProjects,
  conversations,
  mediaObjects,
  messageMedia,
  messages,
  models,
  textRequests,
} from "../db/schema.js";
import { minio } from "../media.js";
import { finishRequestLog, startRequestLog } from "../request-logs.js";
import { generateText, readStreamWithLimit } from "../upstream.js";

const supportedAttachmentMime = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxHistoryMessages = 50;

type AttachmentMedia = {
  id: string;
  bucket: string;
  objectKey: string;
  mimeType: string;
  byteSize: number;
};

async function loadAttachmentImages(media: AttachmentMedia[]) {
  return Promise.all(
    media.map(async (item) => {
      const stream = await minio.getObject(item.bucket, item.objectKey);
      const buffer = await readStreamWithLimit(
        stream,
        config.MAX_UPLOAD_BYTES,
        "附件图片超过上传限制",
        "attachment_too_large",
      );
      return { buffer, mimeType: item.mimeType };
    }),
  );
}

const createBody = z.object({
  requestId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  canvasProjectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200).default("新对话"),
  modelId: z.string().uuid(),
  content: z.string().trim().min(1).max(100000),
  systemPrompt: z.string().max(100000).default(""),
  attachmentMediaIds: z.array(z.string().uuid()).max(20).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
const conversationBody = z.object({
  canvasProjectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200).default("新对话"),
});
const conversationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function textRoutes(app: FastifyInstance) {
  app.post("/conversations", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = conversationBody.parse(request.body);
    if (body.canvasProjectId) {
      const [canvas] = await db
        .select({ id: canvasProjects.id })
        .from(canvasProjects)
        .where(and(eq(canvasProjects.id, body.canvasProjectId), eq(canvasProjects.userId, user.id)))
        .limit(1);
      if (!canvas) return reply.code(400).send({ error: "invalid_canvas", message: "画布项目不存在" });
    }
    const [conversation] = await db
      .insert(conversations)
      .values({ userId: user.id, canvasProjectId: body.canvasProjectId, title: body.title })
      .returning();
    return reply.code(201).send({ conversation });
  });

  app.post("/requests", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = createBody.parse(request.body);
    const [existingRequest] = await db
      .select()
      .from(textRequests)
      .where(and(eq(textRequests.id, body.requestId), eq(textRequests.userId, user.id)))
      .limit(1);
    if (existingRequest?.status === "succeeded" && existingRequest.responseMessageId) {
      const [message] = await db.select().from(messages)
        .where(and(eq(messages.id, existingRequest.responseMessageId), eq(messages.conversationId, existingRequest.conversationId))).limit(1);
      if (message) return { conversationId: existingRequest.conversationId, requestId: existingRequest.id, message };
    }
    if (existingRequest?.status === "running" || existingRequest?.status === "queued") {
      return reply.code(409).send({ error: "request_in_progress", message: "请求正在处理中，请稍候" });
    }
    const [model] = await db
      .select({ id: models.id, name: models.name, displayName: models.displayName })
      .from(models)
      .where(and(eq(models.id, body.modelId), eq(models.capability, "text"), eq(models.status, "published")))
      .limit(1);
    if (!model) return reply.code(400).send({ error: "invalid_model", message: "文本模型不可用" });
    if (!(await hasChannelCandidates(model.id))) {
      return reply.code(503).send({ error: "no_channel", message: "当前模型暂无可用渠道，请联系管理员在平台管理中检查渠道状态" });
    }
    const attachmentMediaIds = [...new Set(body.attachmentMediaIds)];
    if (attachmentMediaIds.length) {
      const visible = await db
        .selectDistinct({
          id: mediaObjects.id,
          bucket: mediaObjects.bucket,
          objectKey: mediaObjects.objectKey,
          mimeType: mediaObjects.mimeType,
          byteSize: mediaObjects.byteSize,
        })
        .from(mediaObjects)
        .leftJoin(assets, eq(assets.mediaId, mediaObjects.id))
        .leftJoin(canvasProjectMedia, eq(canvasProjectMedia.mediaId, mediaObjects.id))
        .leftJoin(canvasProjects, eq(canvasProjects.id, canvasProjectMedia.projectId))
        .where(
          and(
            inArray(mediaObjects.id, attachmentMediaIds),
            or(eq(mediaObjects.ownerId, user.id), eq(assets.scope, "public"), eq(assets.ownerId, user.id), eq(canvasProjects.userId, user.id)),
            eq(mediaObjects.status, "ready"),
          ),
        );
      if (visible.length !== attachmentMediaIds.length) {
        return reply.code(400).send({ error: "invalid_media", message: "附件不存在或无权访问" });
      }
      const maxMb = Math.round(config.MAX_UPLOAD_BYTES / (1024 * 1024));
      if (visible.some((media) => !supportedAttachmentMime.has(media.mimeType) || media.byteSize > config.MAX_UPLOAD_BYTES)) {
        return reply.code(400).send({ error: "invalid_media", message: `附件仅支持 ${maxMb}MB 以内的 PNG、JPEG 或 WebP 图片` });
      }
    }
    if (!body.conversationId && body.canvasProjectId) {
      const [canvas] = await db
        .select({ id: canvasProjects.id })
        .from(canvasProjects)
        .where(and(eq(canvasProjects.id, body.canvasProjectId), eq(canvasProjects.userId, user.id)))
        .limit(1);
      if (!canvas) return reply.code(400).send({ error: "invalid_canvas", message: "画布项目不存在" });
    }

    if (body.conversationId) {
      const [owned] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, body.conversationId), eq(conversations.userId, user.id)))
        .limit(1);
      if (!owned) return reply.code(404).send({ error: "not_found", message: "对话不存在" });
    }

    const startedAt = new Date();
    try {
      const created = await db.transaction(async (tx) => {
        // 同一幂等键的创建和失败重试必须在锁内重新判定，不能复用事务外的旧状态。
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${body.requestId}::uuid::text, 0))`);
        const [currentRequest] = await tx.select().from(textRequests).where(eq(textRequests.id, body.requestId)).limit(1);
        if (currentRequest && (currentRequest.userId !== user.id || !["failed", "canceled"].includes(currentRequest.status))) {
          throw new Error("TEXT_REQUEST_CONFLICT");
        }
        if (Boolean(currentRequest) !== Boolean(existingRequest)) throw new Error("TEXT_REQUEST_CONFLICT");
        let conversationId = existingRequest?.conversationId || body.conversationId;
        if (!conversationId) {
          const [conversation] = await tx
            .insert(conversations)
            .values({ userId: user.id, canvasProjectId: body.canvasProjectId, title: body.title })
            .returning({ id: conversations.id });
          conversationId = conversation!.id;
        }

        let requestMessage: typeof messages.$inferSelect | undefined;
        if (existingRequest?.requestMessageId) {
          const [found] = await tx
            .select()
            .from(messages)
            .where(eq(messages.id, existingRequest.requestMessageId))
            .limit(1);
          if (found) {
            if (found.content !== body.content || JSON.stringify(found.attachments) !== JSON.stringify(attachmentMediaIds)
              || existingRequest?.modelId !== body.modelId || (body.conversationId && body.conversationId !== conversationId)) {
              throw new Error("TEXT_REQUEST_CONFLICT");
            }
            requestMessage = found;
          }
        }

        if (!requestMessage) {
          const inserted = await tx
            .insert(messages)
            .values({ conversationId, role: "user", content: body.content, attachments: attachmentMediaIds })
            .returning();
          requestMessage = inserted[0]!;
          if (attachmentMediaIds.length) {
            const claimed = await tx
              .update(mediaObjects)
              .set({ referenceCount: sql`${mediaObjects.referenceCount} + 1` })
              .where(and(inArray(mediaObjects.id, attachmentMediaIds), eq(mediaObjects.status, "ready")))
              .returning({ id: mediaObjects.id });
            if (claimed.length !== attachmentMediaIds.length) throw new Error("MEDIA_UNAVAILABLE");
            await tx.insert(messageMedia).values(
              attachmentMediaIds.map((mediaId) => ({ messageId: requestMessage!.id, mediaId })),
            );
          }
        }

        const [textRequest] = existingRequest
          ? await tx
              .update(textRequests)
              .set({
                conversationId,
                requestMessageId: requestMessage.id,
                modelId: body.modelId,
                status: "running",
                errorCode: null,
                responseMessageId: null,
                startedAt,
                finishedAt: null,
              })
              .where(eq(textRequests.id, body.requestId))
              .returning()
          : await tx
              .insert(textRequests)
              .values({
                id: body.requestId,
                userId: user.id,
                conversationId,
                requestMessageId: requestMessage.id,
                modelId: body.modelId,
                status: "running",
                startedAt,
              })
              .returning();
        return { conversationId, requestMessage, textRequest: textRequest! };
      });
      const { conversationId, textRequest } = created;

      let activeRequestLogId: string | undefined;
      try {
        const recentMessages = await db
          .select({ id: messages.id, role: messages.role, content: messages.content, attachments: messages.attachments })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(maxHistoryMessages);
        const history = recentMessages.reverse();
        const historyMedia = await db.select({
          messageId: messageMedia.messageId,
          id: mediaObjects.id,
          bucket: mediaObjects.bucket,
          objectKey: mediaObjects.objectKey,
          mimeType: mediaObjects.mimeType,
          byteSize: mediaObjects.byteSize,
        }).from(messageMedia).innerJoin(mediaObjects, eq(mediaObjects.id, messageMedia.mediaId))
          .where(and(inArray(messageMedia.messageId, history.map((message) => message.id)), eq(mediaObjects.status, "ready")));
        const uniqueMedia = [...new Map(historyMedia.map((media) => [media.id, media])).values()];
        const images = await loadAttachmentImages(uniqueMedia);
        const imagesById = new Map(uniqueMedia.map((media, index) => [media.id, images[index]!]));
        const upstreamMessages = history.map(({ attachments, ...message }) => ({
          ...message,
          images: Array.isArray(attachments) ? attachments.flatMap((id) => imagesById.has(id) ? [imagesById.get(id)!] : []) : [],
        }));
        if (body.systemPrompt) upstreamMessages.unshift({ id: "system", role: "system", content: body.systemPrompt, images: [] });
        const { result: content, candidate } = await runWithFailover(body.modelId, async (channel) => {
          await db
            .update(textRequests)
            .set({ channelId: channel.channelId, upstreamModel: channel.upstreamModel })
            .where(eq(textRequests.id, textRequest.id));
          const requestLogId = await startRequestLog({
            userId: user.id,
            type: "text",
            textRequestId: textRequest.id,
            modelId: model.id,
            modelNameSnapshot: model.name,
            modelDisplayNameSnapshot: model.displayName,
            channelId: channel.channelId,
            channelNameSnapshot: channel.channelName,
            upstreamModel: channel.upstreamModel,
          });
          try {
            const result = await generateText(channel, upstreamMessages, body.parameters);
            activeRequestLogId = requestLogId;
            return result;
          } catch (error) {
            const upstream = error instanceof UpstreamError ? error : new UpstreamError("文本请求失败", "internal_error");
            await finishRequestLog(requestLogId, upstream);
            throw upstream;
          }
        });
        const finishedAt = new Date();
        const responseMessage = await db.transaction(async (tx) => {
          const response = await tx
            .insert(messages)
            .values({ conversationId, role: "assistant", content })
            .returning();
          await tx
            .update(textRequests)
            .set({
              responseMessageId: response[0]!.id,
              channelId: candidate.channelId,
              upstreamModel: candidate.upstreamModel,
              status: "succeeded",
              durationMs: finishedAt.getTime() - startedAt.getTime(),
              finishedAt,
            })
            .where(eq(textRequests.id, textRequest.id));
          await tx.update(conversations).set({ updatedAt: finishedAt }).where(eq(conversations.id, conversationId));
          return response[0]!;
        });
        await finishRequestLog(activeRequestLogId);
        return { conversationId, requestId: textRequest.id, message: responseMessage };
      } catch (error) {
        const upstream = error instanceof UpstreamError ? error : new UpstreamError("文本请求失败", "internal_error");
        const finishedAt = new Date();
        await db
          .update(textRequests)
          .set({ status: "failed", errorCode: upstream.category, durationMs: finishedAt.getTime() - startedAt.getTime(), finishedAt })
          .where(eq(textRequests.id, textRequest.id));
        if (activeRequestLogId) {
          await finishRequestLog(activeRequestLogId, upstream);
        }
        return reply.code(502).send({ error: upstream.category, message: upstream.message, conversationId, requestId: textRequest.id });
      }
    } catch (error) {
      if (error instanceof Error && error.message === "TEXT_REQUEST_CONFLICT") {
        return reply.code(409).send({ error: "request_conflict", message: "请求已被处理或重试内容发生变化，请刷新状态后重试" });
      }
      if (error instanceof Error && error.message === "MEDIA_UNAVAILABLE") {
        return reply.code(400).send({ error: "invalid_media", message: "附件已不可用" });
      }
      throw error;
    }
  });

  app.get("/conversations", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { limit, offset } = conversationListQuery.parse(request.query);
    return {
      conversations: await db
        .select()
        .from(conversations)
        .where(eq(conversations.userId, user.id))
        .orderBy(desc(conversations.updatedAt))
        .limit(limit)
        .offset(offset),
    };
  });

  app.get("/conversations/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .limit(1);
    if (!conversation) return reply.code(404).send({ error: "not_found", message: "对话不存在" });
    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const [latestRequest] = await db
      .select({ id: textRequests.id, status: textRequests.status, errorCode: textRequests.errorCode, responseMessageId: textRequests.responseMessageId, createdAt: textRequests.createdAt, finishedAt: textRequests.finishedAt })
      .from(textRequests)
      .where(eq(textRequests.conversationId, id))
      .orderBy(desc(textRequests.createdAt))
      .limit(1);
    return { conversation, messages: history, latestRequest: latestRequest ?? null };
  });

  app.get("/requests/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [textRequest] = await db
      .select({
        id: textRequests.id,
        conversationId: textRequests.conversationId,
        responseMessageId: textRequests.responseMessageId,
        status: textRequests.status,
        errorCode: textRequests.errorCode,
        createdAt: textRequests.createdAt,
        finishedAt: textRequests.finishedAt,
      })
      .from(textRequests)
      .where(and(eq(textRequests.id, id), eq(textRequests.userId, user.id)))
      .limit(1);
    if (!textRequest) return reply.code(404).send({ error: "not_found", message: "文本请求不存在" });
    const [responseMessage] = textRequest.responseMessageId
      ? await db
          .select()
          .from(messages)
          .where(and(eq(messages.id, textRequest.responseMessageId), eq(messages.conversationId, textRequest.conversationId)))
          .limit(1)
      : [];
    return { request: textRequest, message: responseMessage ?? null };
  });
}
