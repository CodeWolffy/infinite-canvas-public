import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "./db/client.js";
import { config } from "./config.js";
import {
  assets,
  canvasProjectHistoryMedia,
  canvasProjectMedia,
  generatedImages,
  generationBatchMedia,
  mediaObjects,
  messageMedia,
} from "./db/schema.js";
import { minio } from "./media.js";

export async function removeUnreferencedMedia(
  mediaIds: string[],
  reportError: (error: unknown, mediaId: string) => void,
) {
  const uniqueIds = [...new Set(mediaIds)];
  if (!uniqueIds.length) return;

  let toDelete: Array<{ id: string; bucket: string; objectKey: string }> = [];
  try {
    toDelete = await db.transaction(async (tx) => {
      // 1. 批量锁定候选对象状态为 deleting
      const claimed = await tx
        .update(mediaObjects)
        .set({ status: "deleting" })
        .where(and(inArray(mediaObjects.id, uniqueIds), inArray(mediaObjects.status, ["ready", "deleting"])))
        .returning({ id: mediaObjects.id, bucket: mediaObjects.bucket, objectKey: mediaObjects.objectKey });

      if (!claimed.length) return [];
      const claimedIds = claimed.map((item) => item.id);

      // 2. 批量检查当前业务数据和历史快照的引用
      const [refAssets, refGenerated, refCanvas, refHistory, refBatch, refMessage] = await Promise.all([
        tx.select({ mediaId: assets.mediaId }).from(assets).where(inArray(assets.mediaId, claimedIds)),
        tx.select({ mediaId: generatedImages.mediaId }).from(generatedImages).where(inArray(generatedImages.mediaId, claimedIds)),
        tx.select({ mediaId: canvasProjectMedia.mediaId }).from(canvasProjectMedia).where(inArray(canvasProjectMedia.mediaId, claimedIds)),
        tx.select({ mediaId: canvasProjectHistoryMedia.mediaId }).from(canvasProjectHistoryMedia).where(inArray(canvasProjectHistoryMedia.mediaId, claimedIds)),
        tx.select({ mediaId: generationBatchMedia.mediaId }).from(generationBatchMedia).where(inArray(generationBatchMedia.mediaId, claimedIds)),
        tx.select({ mediaId: messageMedia.mediaId }).from(messageMedia).where(inArray(messageMedia.mediaId, claimedIds)),
      ]);

      const referencedSet = new Set<string>();
      for (const row of [...refAssets, ...refGenerated, ...refCanvas, ...refHistory, ...refBatch, ...refMessage]) {
        if (row.mediaId) referencedSet.add(row.mediaId);
      }

      // 3. 仍有引用的恢复为 ready
      if (referencedSet.size > 0) {
        await tx
          .update(mediaObjects)
          .set({ status: "ready" })
          .where(inArray(mediaObjects.id, [...referencedSet]));
      }

      return claimed.filter((item) => !referencedSet.has(item.id));
    });
  } catch (error) {
    reportError(error, uniqueIds.join(","));
    return;
  }

  if (!toDelete.length) return;

  // MinIO 确认删除后才释放元数据，失败的 deleting 记录可由后续清理重试。
  const byBucket = new Map<string, typeof toDelete>();
  for (const item of toDelete) {
    const list = byBucket.get(item.bucket) ?? [];
    list.push(item);
    byBucket.set(item.bucket, list);
  }

  for (const [bucket, items] of byBucket) {
    try {
      const errors = await minio.removeObjects(bucket, items.map((item) => item.objectKey));
      if (errors.length) throw new Error("部分 MinIO 对象删除失败，已保留记录等待重试");
      await db.delete(mediaObjects).where(and(inArray(mediaObjects.id, items.map((item) => item.id)), eq(mediaObjects.status, "deleting")));
    } catch (error) {
      for (const item of items) {
        reportError(error, item.id);
      }
    }
  }
}

export async function cleanupOrphanMedia(reportError: (error: unknown, mediaId: string) => void) {
  const cutoff = new Date(Date.now() - config.ORPHAN_MEDIA_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .leftJoin(assets, eq(assets.mediaId, mediaObjects.id))
    .leftJoin(canvasProjectMedia, eq(canvasProjectMedia.mediaId, mediaObjects.id))
    .leftJoin(canvasProjectHistoryMedia, eq(canvasProjectHistoryMedia.mediaId, mediaObjects.id))
    .leftJoin(generatedImages, eq(generatedImages.mediaId, mediaObjects.id))
    .leftJoin(generationBatchMedia, eq(generationBatchMedia.mediaId, mediaObjects.id))
    .leftJoin(messageMedia, eq(messageMedia.mediaId, mediaObjects.id))
    .where(
      or(
        eq(mediaObjects.status, "deleting"),
        and(
          eq(mediaObjects.status, "ready"),
          eq(mediaObjects.referenceCount, 0),
          lte(mediaObjects.createdAt, cutoff),
          isNull(assets.id),
          isNull(canvasProjectMedia.projectId),
          isNull(canvasProjectHistoryMedia.historyId),
          isNull(generatedImages.id),
          isNull(generationBatchMedia.batchId),
          isNull(messageMedia.messageId),
        ),
      ),
    )
    .limit(500);
  await removeUnreferencedMedia(rows.map((row) => row.id), reportError);
  return rows.length;
}

export function startOrphanCleanup(reportError: (error: unknown, mediaId: string) => void) {
  const run = () => {
    void cleanupOrphanMedia(reportError).catch(() => undefined);
  };
  run();
  return setInterval(run, 24 * 60 * 60 * 1000);
}

export function stopOrphanCleanup(timer: ReturnType<typeof setInterval>) {
  clearInterval(timer);
}
