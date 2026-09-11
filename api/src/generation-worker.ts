import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { imageSize } from "image-size";
import PgBoss from "pg-boss";
import { runWithFailover, UpstreamError } from "./channel-scheduler.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import {
  generatedImages,
  generationAttempts,
  generationBatchMedia,
  generationTasks,
  mediaObjects,
  requestLogs,
} from "./db/schema.js";
import { minio } from "./media.js";
import { finishRequestLog, startRequestLog } from "./request-logs.js";
import { generateImage, readStreamWithLimit, validateGeneratedImage } from "./upstream.js";

const queueName = "generate-image";
export const boss = new PgBoss({ connectionString: config.DATABASE_URL });

type ReferenceImage = { buffer: Buffer; mimeType: string; filename: string };

async function loadReferences(batchId: string): Promise<ReferenceImage[]> {
  const rows = await db
    .select({ media: mediaObjects, sequence: generationBatchMedia.sequence })
    .from(generationBatchMedia)
    .innerJoin(mediaObjects, eq(mediaObjects.id, generationBatchMedia.mediaId))
    .where(eq(generationBatchMedia.batchId, batchId))
    .orderBy(asc(generationBatchMedia.sequence));
  return Promise.all(
    rows.map(async ({ media }) => {
      const stream = await minio.getObject(media.bucket, media.objectKey);
      const buffer = await readStreamWithLimit(
        stream,
        config.MAX_UPLOAD_BYTES,
        "参考图片超过上传限制",
        "reference_too_large",
      );
      return { buffer, mimeType: media.mimeType, filename: media.originalName };
    }),
  );
}

/**
 * 同一批次的多个任务共用一份参考图：批次有 N 张图时原本会把同样的参考图从 MinIO 拉 N 次、
 * 在内存里存 N 份。按 batchId 引用计数复用，最后一个任务用完即释放。
 */
const referenceCache = new Map<string, { promise: Promise<ReferenceImage[]>; users: number }>();

function releaseReferences(batchId: string) {
  const entry = referenceCache.get(batchId);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users <= 0) referenceCache.delete(batchId);
}

async function acquireReferences(batchId: string) {
  const entry = referenceCache.get(batchId) ?? { promise: loadReferences(batchId), users: 0 };
  entry.users += 1;
  referenceCache.set(batchId, entry);
  try {
    return await entry.promise;
  } catch (error) {
    releaseReferences(batchId);
    throw error;
  }
}

async function processTask(taskId: string) {
  const [task] = await db.select().from(generationTasks).where(eq(generationTasks.id, taskId)).limit(1);
  if (!task || task.status !== "queued") return;
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${task.batchId}::text, 0))`);
    const [result] = await tx
      .update(generationTasks)
      .set({ status: "running", startedAt: new Date(), finishedAt: null, errorCode: null, errorMessage: null })
      .where(and(eq(generationTasks.id, taskId), eq(generationTasks.status, "queued")))
      .returning();
    return result;
  });
  if (!claimed) return;

  let activeRequestLogId: string | undefined;
  let activeAttemptId: string | undefined;
  const failedAttemptWrites: Array<() => PromiseLike<unknown>> = [];
  try {
    const references = await acquireReferences(task.batchId);
    try {
      const [attemptState] = await db
        .select({ maxAttempt: max(generationAttempts.attemptNumber) })
        .from(generationAttempts)
        .where(eq(generationAttempts.taskId, task.id));
      const attemptOffset = attemptState?.maxAttempt ?? 0;
      const generation = await runWithFailover(task.modelId, async (channel, attemptNumber) => {
        const startedAt = new Date();
        const [attempt] = await db
          .insert(generationAttempts)
          .values({
            taskId: task.id,
            channelId: channel.channelId,
            channelNameSnapshot: channel.channelName,
            upstreamModel: channel.upstreamModel,
            attemptNumber: attemptOffset + attemptNumber,
          })
          .returning();
        const requestLogId = await startRequestLog({
          userId: task.userId,
          type: "image",
          taskId: task.id,
          modelId: task.modelId,
          modelNameSnapshot: task.modelNameSnapshot,
          modelDisplayNameSnapshot: task.modelDisplayNameSnapshot,
          channelId: channel.channelId,
          channelNameSnapshot: channel.channelName,
          upstreamModel: channel.upstreamModel,
        });
        try {
          const image = await generateImage(
            channel,
            task.prompt,
            (task.parameters ?? {}) as Record<string, unknown>,
            references,
          );
          const detected = await validateGeneratedImage(image);
          activeRequestLogId = requestLogId;
          activeAttemptId = attempt!.id;
          return { image, detected, startedAt };
        } catch (error) {
          const upstream = error instanceof UpstreamError ? error : new UpstreamError("上游请求失败", "unknown", undefined, "once");
          const finishedAt = new Date();
          const recordFailure = () => db
            .update(generationAttempts)
            .set({
              status: "failed",
              httpStatus: upstream.httpStatus,
              errorCategory: upstream.category,
              errorMessage: upstream.message,
              finishedAt,
              durationMs: finishedAt.getTime() - startedAt.getTime(),
            })
            .where(eq(generationAttempts.id, attempt!.id));
          try {
            await recordFailure();
          } catch {
            failedAttemptWrites.push(recordFailure);
          }
          await finishRequestLog(requestLogId, upstream);
          throw upstream;
        }
      });
      const { image, detected, startedAt } = generation.result;
      const dimensions = imageSize(image);
      const objectKey = `generated/${task.userId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${detected.ext}`;
      await minio.putObject(config.MINIO_BUCKET, objectKey, image, image.length, { "Content-Type": detected.mime });
      try {
        const finishedAt = new Date();
        await db.transaction(async (tx) => {
          const [media] = await tx
            .insert(mediaObjects)
            .values({
              ownerId: task.userId,
              bucket: config.MINIO_BUCKET,
              objectKey,
              originalName: `${task.id}.${detected.ext}`,
              mimeType: detected.mime,
              byteSize: image.length,
              width: dimensions.width,
              height: dimensions.height,
              sha256: createHash("sha256").update(image).digest("hex"),
              referenceCount: 1,
            })
            .returning();
          await tx.insert(generatedImages).values({
            taskId: task.id,
            mediaId: media!.id,
            billedAmount: task.priceSnapshot ?? "0",
          });
          if (activeAttemptId) {
            await tx
              .update(generationAttempts)
              .set({ status: "succeeded", finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() })
              .where(eq(generationAttempts.id, activeAttemptId));
          }
          await tx
            .update(generationTasks)
            .set({ status: "succeeded", finishedAt })
            .where(eq(generationTasks.id, task.id));
        });
        await finishRequestLog(activeRequestLogId, undefined, task.priceSnapshot ?? "0");
      } catch (error) {
        await minio.removeObject(config.MINIO_BUCKET, objectKey);
        throw error;
      }
    } finally {
      await releaseReferences(task.batchId);
    }
  } catch (error) {
    const upstream = error instanceof UpstreamError ? error : new UpstreamError("图片任务失败", "internal_error");
    const finishedAt = new Date();
    await db
      .update(generationTasks)
      .set({ status: "failed", errorCode: upstream.category, errorMessage: upstream.message, finishedAt })
      .where(eq(generationTasks.id, task.id));
    if (activeAttemptId) {
      await db
        .update(generationAttempts)
        .set({
          status: "failed",
          errorCategory: upstream.category,
          errorMessage: upstream.message,
          finishedAt,
        })
        .where(and(eq(generationAttempts.id, activeAttemptId), eq(generationAttempts.status, "running")));
    }
    if (activeRequestLogId) {
      await finishRequestLog(activeRequestLogId, upstream);
    }
  } finally {
    // 任务收口时补记未完成的尝试，记录失败不得改写上游结果或触发额外生成。
    for (const recordFailure of failedAttemptWrites) {
      try {
        await recordFailure();
      } catch {
        console.warn("[GenerationWorker] 尝试记录未能完成写入", { taskId: task.id });
      }
    }
  }
}

export async function enqueueGenerationTask(taskId: string) {
  await boss.send(queueName, { taskId }, { retryLimit: 0, singletonKey: taskId, expireInSeconds: 3600 });
}

export async function startGenerationWorker() {
  await boss.start();
  const existingQueue = await boss.getQueue(queueName);
  if (existingQueue && existingQueue.policy !== "standard") {
    await boss.updateQueue(queueName, { name: queueName, policy: "standard" });
  }
  await boss.createQueue(queueName, { name: queueName, policy: "standard" });
  const recovered = await db
    .update(generationTasks)
    .set({ status: "queued", startedAt: null, errorCode: null, errorMessage: null })
    .where(eq(generationTasks.status, "running"))
    .returning({ id: generationTasks.id });
  if (recovered.length) {
    await db
      .update(generationAttempts)
      .set({
        status: "failed",
        errorCategory: "worker_restart",
        errorMessage: "服务重启，中断的任务已重新排队",
        finishedAt: new Date(),
      })
      .where(
        and(
          inArray(generationAttempts.taskId, recovered.map((task) => task.id)),
          eq(generationAttempts.status, "running"),
        ),
      );
    await db
      .update(requestLogs)
      .set({ status: "failed", errorCategory: "worker_restart", errorMessage: "服务重启，中断的任务已重新排队", finishedAt: new Date() })
      .where(
        and(
          inArray(requestLogs.taskId, recovered.map((task) => task.id)),
          eq(requestLogs.status, "running"),
        ),
      );
  }
  const queued = await db
    .select({ id: generationTasks.id })
    .from(generationTasks)
    .where(eq(generationTasks.status, "queued"));
  for (const task of queued) await enqueueGenerationTask(task.id);
  const workerPromises = Array.from({ length: config.IMAGE_WORKER_CONCURRENCY }, () =>
    boss.work<{ taskId: string }>(
      queueName,
      { batchSize: 1 },
      async ([job]) => {
        if (job?.data?.taskId) await processTask(job.data.taskId);
      },
    ),
  );
  await Promise.all(workerPromises);
}

export async function stopGenerationWorker() {
  await boss.stop();
}
