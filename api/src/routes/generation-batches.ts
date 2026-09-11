import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";
import {
  assets,
  canvasProjectMedia,
  canvasProjects,
  generatedImages,
  generationBatchMedia,
  generationBatches,
  generationTasks,
  mediaObjects,
  models,
} from "../db/schema.js";
import { enqueueGenerationTask } from "../generation-worker.js";
import { hasChannelCandidates } from "../channel-scheduler.js";
import { removeUnreferencedMedia } from "../media-cleanup.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const taskParams = z.object({ taskId: z.string().uuid() });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) });
const createBody = z.object({
  modelId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(50000),
  count: z.number().int().min(1).max(20),
  canvasProjectId: z.string().uuid().nullable().optional(),
  referenceMediaIds: z.array(z.string().uuid()).max(20).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

import { config } from "../config.js";

class ActiveTaskLimitError extends Error {}

async function checkUserTaskCapacity(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string, count: number) {
  const maxActiveTasks = 50;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"image-capacity:" + userId}::text, 0))`);
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(generationTasks)
    .where(and(eq(generationTasks.userId, userId), inArray(generationTasks.status, ["queued", "running"])));
  const activeCount = Number(row?.count ?? 0);
  if (activeCount + count > maxActiveTasks) {
    throw new ActiveTaskLimitError(`您当前已有 ${activeCount} 个任务排队或运行中，超过人均并发上限 (${maxActiveTasks})，请等待当前任务完成后再提交`);
  }
}

function publicTask(task: typeof generationTasks.$inferSelect, media?: typeof mediaObjects.$inferSelect, isSaved?: boolean) {
  return {
    id: task.id,
    batchId: task.batchId,
    status: task.status,
    sequence: task.sequence,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    modelName: task.modelNameSnapshot,
    modelDisplayName: task.modelDisplayNameSnapshot,
    ...(media ? {
      image: {
        mediaId: media.id,
        url: `/api/media/${media.id}`,
        mimeType: media.mimeType,
        bytes: media.byteSize,
        width: media.width,
        height: media.height,
        isSaved: Boolean(isSaved),
      },
    } : {}),
  };
}

function publicBatch(batch: typeof generationBatches.$inferSelect, summary?: BatchSummary) {
  return {
    id: batch.id,
    canvasProjectId: batch.canvasProjectId,
    modelId: batch.modelId,
    prompt: batch.prompt,
    requestedCount: batch.requestedCount,
    parameters: batch.parameters,
    createdAt: batch.createdAt,
    retentionDays: config.ORPHAN_MEDIA_GRACE_DAYS,
    ...(summary ? { summary } : {}),
  };
}

export type BatchSummary = {
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  activeCount: number;
  savedCount: number;
  thumbnailMediaIds: string[];
};

async function enqueueOrFail(taskId: string) {
  try {
    await enqueueGenerationTask(taskId);
    return true;
  } catch {
    await db
      .update(generationTasks)
      .set({
        status: "failed",
        errorCode: "queue_unavailable",
        errorMessage: "任务队列暂时不可用",
        finishedAt: new Date(),
      })
      .where(eq(generationTasks.id, taskId));
    return false;
  }
}

export async function generationBatchRoutes(app: FastifyInstance) {
  app.post("/", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = createBody.parse(request.body);

    const [model] = await db
      .select()
      .from(models)
      .where(and(eq(models.id, body.modelId), eq(models.capability, "image"), eq(models.status, "published")))
      .limit(1);
    if (!model) return reply.code(400).send({ error: "invalid_model", message: "图片模型不可用" });
    if (!(await hasChannelCandidates(model.id))) {
      return reply.code(503).send({ error: "no_channel", message: "当前模型暂无可用渠道，请联系管理员在平台管理中检查渠道状态" });
    }
    if (body.canvasProjectId) {
      const [canvas] = await db
        .select({ id: canvasProjects.id })
        .from(canvasProjects)
        .where(and(eq(canvasProjects.id, body.canvasProjectId), eq(canvasProjects.userId, user.id)))
        .limit(1);
      if (!canvas) return reply.code(400).send({ error: "invalid_canvas", message: "画布项目不存在" });
    }
    const uniqueReferences = [...new Set(body.referenceMediaIds)];
    if (uniqueReferences.length) {
      const owned = await db
        .selectDistinct({ id: mediaObjects.id })
        .from(mediaObjects)
        .leftJoin(assets, eq(assets.mediaId, mediaObjects.id))
        .leftJoin(canvasProjectMedia, eq(canvasProjectMedia.mediaId, mediaObjects.id))
        .leftJoin(canvasProjects, eq(canvasProjects.id, canvasProjectMedia.projectId))
        .where(
          and(
            inArray(mediaObjects.id, uniqueReferences),
            or(eq(mediaObjects.ownerId, user.id), eq(assets.scope, "public"), eq(assets.ownerId, user.id), eq(canvasProjects.userId, user.id)),
            eq(mediaObjects.status, "ready"),
          ),
        );
      if (owned.length !== uniqueReferences.length) {
        return reply.code(400).send({ error: "invalid_media", message: "参考图片不存在或无权访问" });
      }
    }

    let result;
    try {
      result = await db.transaction(async (tx) => {
        await checkUserTaskCapacity(tx, user.id, body.count);
        const [batch] = await tx
          .insert(generationBatches)
          .values({
            userId: user.id,
            modelId: model.id,
            canvasProjectId: body.canvasProjectId,
            prompt: body.prompt,
            requestedCount: body.count,
            parameters: body.parameters,
          })
          .returning();
        if (uniqueReferences.length) {
          const claimed = await tx
            .update(mediaObjects)
            .set({ referenceCount: sql`${mediaObjects.referenceCount} + 1` })
            .where(and(inArray(mediaObjects.id, uniqueReferences), eq(mediaObjects.status, "ready")))
            .returning({ id: mediaObjects.id });
          if (claimed.length !== uniqueReferences.length) throw new Error("MEDIA_UNAVAILABLE");
          await tx.insert(generationBatchMedia).values(
            uniqueReferences.map((mediaId, sequence) => ({ batchId: batch!.id, mediaId, sequence })),
          );
        }
        const tasks = await tx
          .insert(generationTasks)
          .values(
            Array.from({ length: body.count }, (_, sequence) => ({
              batchId: batch!.id,
              userId: user.id,
              modelId: model.id,
              sequence,
              prompt: body.prompt,
              parameters: body.parameters,
              priceSnapshot: model.pricePerImage,
              modelNameSnapshot: model.name,
              modelDisplayNameSnapshot: model.displayName,
            })),
          )
          .returning();
        return { batch: batch!, tasks };
      });
    } catch (error) {
      if (error instanceof ActiveTaskLimitError) return reply.code(429).send({ error: "too_many_active_tasks", message: error.message });
      if (error instanceof Error && error.message === "MEDIA_UNAVAILABLE") {
        return reply.code(400).send({ error: "invalid_media", message: "参考图片已不可用" });
      }
      throw error;
    }
    await Promise.all(result.tasks.map((task) => enqueueOrFail(task.id)));
    const createdTasks = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.batchId, result.batch.id))
      .orderBy(asc(generationTasks.sequence));
    return reply.code(202).send({ batch: publicBatch(result.batch), tasks: createdTasks.map((task) => publicTask(task)) });
  });

  app.get("/", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { limit, offset } = listQuery.parse(request.query);
    const batches = await db
      .select()
      .from(generationBatches)
      .where(eq(generationBatches.userId, user.id))
      .orderBy(desc(generationBatches.createdAt))
      .limit(limit)
      .offset(offset);
    if (!batches.length) return { batches: [] };
    const taskRows = await db
      .select({
        batchId: generationTasks.batchId,
        status: generationTasks.status,
        mediaId: generatedImages.mediaId,
        savedAssetId: assets.id,
      })
      .from(generationTasks)
      .leftJoin(generatedImages, eq(generatedImages.taskId, generationTasks.id))
      .leftJoin(assets, and(eq(assets.mediaId, generatedImages.mediaId), eq(assets.ownerId, user.id)))
      .where(inArray(generationTasks.batchId, batches.map((batch) => batch.id)))
      .orderBy(asc(generationTasks.sequence));
    const tasksByBatch = new Map<string, typeof taskRows>();
    for (const row of taskRows) {
      const list = tasksByBatch.get(row.batchId) ?? [];
      list.push(row);
      tasksByBatch.set(row.batchId, list);
    }
    return {
      batches: batches.map((batch) => {
        const tasks = tasksByBatch.get(batch.id) ?? [];
        const summary: BatchSummary = {
          totalCount: tasks.length,
          succeededCount: tasks.filter((task) => task.status === "succeeded").length,
          failedCount: tasks.filter((task) => task.status === "failed" || task.status === "canceled").length,
          activeCount: tasks.filter((task) => task.status === "queued" || task.status === "running").length,
          savedCount: tasks.filter((task) => task.savedAssetId).length,
          thumbnailMediaIds: tasks.flatMap((task) => (task.mediaId ? [task.mediaId] : [])).slice(0, 4),
        };
        return publicBatch(batch, summary);
      }),
    };
  });

  app.get("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const [batch] = await db
      .select()
      .from(generationBatches)
      .where(and(eq(generationBatches.id, id), eq(generationBatches.userId, user.id)))
      .limit(1);
    if (!batch) return reply.code(404).send({ error: "not_found", message: "生成批次不存在" });
    const tasks = await db
      .select({ task: generationTasks, media: mediaObjects, assetId: assets.id })
      .from(generationTasks)
      .leftJoin(generatedImages, eq(generatedImages.taskId, generationTasks.id))
      .leftJoin(mediaObjects, eq(mediaObjects.id, generatedImages.mediaId))
      .leftJoin(assets, and(eq(assets.mediaId, mediaObjects.id), eq(assets.ownerId, user.id)))
      .where(eq(generationTasks.batchId, id))
      .orderBy(asc(generationTasks.sequence));
    const referenceMediaIds = await db
      .select({ mediaId: generationBatchMedia.mediaId })
      .from(generationBatchMedia)
      .where(eq(generationBatchMedia.batchId, id))
      .orderBy(asc(generationBatchMedia.sequence));
    return {
      batch: publicBatch(batch),
      tasks: tasks.map(({ task, media, assetId }) => publicTask(task, media ?? undefined, Boolean(assetId))),
      referenceMediaIds: referenceMediaIds.map((item) => item.mediaId),
    };
  });

  app.delete("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const deletion = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}::uuid::text, 0))`);
      const [batch] = await tx
        .select({ id: generationBatches.id })
        .from(generationBatches)
        .where(and(eq(generationBatches.id, id), eq(generationBatches.userId, user.id)))
        .limit(1);
      if (!batch) return { status: "not_found" as const, mediaIds: [] };

      const [activeTask] = await tx
        .select({ id: generationTasks.id })
        .from(generationTasks)
        .where(
          and(
            eq(generationTasks.batchId, id),
            or(eq(generationTasks.status, "queued"), eq(generationTasks.status, "running")),
          ),
        )
        .limit(1);
      if (activeTask) return { status: "in_progress" as const, mediaIds: [] };

      const references = await tx
        .select({ mediaId: generationBatchMedia.mediaId })
        .from(generationBatchMedia)
        .where(eq(generationBatchMedia.batchId, id));
      const outputs = await tx
        .select({ mediaId: generatedImages.mediaId })
        .from(generatedImages)
        .innerJoin(generationTasks, eq(generationTasks.id, generatedImages.taskId))
        .where(eq(generationTasks.batchId, id));
      const referenceIds = references.map((item) => item.mediaId);
      const outputIds = outputs.map((item) => item.mediaId);

      await tx.delete(generationBatches).where(and(eq(generationBatches.id, id), eq(generationBatches.userId, user.id)));
      if (referenceIds.length) {
        await tx
          .update(mediaObjects)
          .set({ referenceCount: sql`greatest(${mediaObjects.referenceCount} - 1, 0)` })
          .where(inArray(mediaObjects.id, referenceIds));
      }
      if (outputIds.length) {
        await tx
          .update(mediaObjects)
          .set({ referenceCount: sql`greatest(${mediaObjects.referenceCount} - 1, 0)` })
          .where(inArray(mediaObjects.id, outputIds));
      }
      return { status: "deleted" as const, mediaIds: [...referenceIds, ...outputIds] };
    });
    if (deletion.status === "not_found") {
      return reply.code(404).send({ error: "not_found", message: "生成批次不存在" });
    }
    if (deletion.status === "in_progress") {
      return reply.code(409).send({ error: "batch_in_progress", message: "生成任务仍在排队或运行，暂不能删除" });
    }
    await removeUnreferencedMedia(deletion.mediaIds, (error, mediaId) => {
      app.log.error({ err: error, mediaId }, "删除无引用的 MinIO 对象失败");
    });
    return reply.code(204).send();
  });

  app.post("/tasks/:taskId/retry", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { taskId } = taskParams.parse(request.params);
    let task;
    try {
      task = await db.transaction(async (tx) => {
        await checkUserTaskCapacity(tx, user.id, 1);
        const [candidate] = await tx
          .select({ batchId: generationTasks.batchId })
          .from(generationTasks)
          .where(and(eq(generationTasks.id, taskId), eq(generationTasks.userId, user.id)))
          .limit(1);
        if (!candidate) return undefined;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${candidate.batchId}::text, 0))`);
        const [retried] = await tx
          .update(generationTasks)
          .set({ status: "queued", queuedAt: new Date(), startedAt: null, finishedAt: null, errorCode: null, errorMessage: null })
          .where(and(eq(generationTasks.id, taskId), eq(generationTasks.userId, user.id), eq(generationTasks.status, "failed")))
          .returning();
        return retried;
      });
    } catch (error) {
      if (error instanceof ActiveTaskLimitError) return reply.code(429).send({ error: "too_many_active_tasks", message: error.message });
      throw error;
    }
    if (!task) return reply.code(409).send({ error: "not_retryable", message: "任务不存在或当前不可重试" });
    if (!(await enqueueOrFail(task.id))) {
      return reply.code(503).send({ error: "queue_unavailable", message: "任务队列暂时不可用" });
    }
    return reply.code(202).send({ task: publicTask(task) });
  });
}
