import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { assets, canvasProjectHistory, canvasProjectHistoryMedia, canvasProjectMedia, mediaObjects } from "./db/schema.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mediaUrlPattern = /\/api\/media\/([0-9a-f-]{36})(?:\b|\/|\?|#)/gi;

export function extractMediaIds(value: unknown) {
  const ids = new Set<string>();
  const visit = (current: unknown, key?: string) => {
    if (typeof current === "string") {
      if ((key === "mediaId" || key === "fileId") && uuidPattern.test(current)) ids.add(current);
      if (key === "storageKey") {
        const storageId = current.replace(/^image:/, "");
        if (uuidPattern.test(storageId)) ids.add(storageId);
      }
      for (const match of current.matchAll(mediaUrlPattern)) if (match[1]) ids.add(match[1]);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key);
      return;
    }
    if (current && typeof current === "object") {
      for (const [childKey, child] of Object.entries(current)) {
        if ((childKey === "mediaIds" || childKey === "fileIds") && Array.isArray(child)) {
          for (const id of child) if (typeof id === "string" && uuidPattern.test(id)) ids.add(id);
        }
        visit(child, childKey);
      }
    }
  };
  visit(value);
  return [...ids];
}

export async function syncCanvasMedia(tx: Transaction, projectId: string, userId: string, snapshot: unknown) {
  const requestedIds = extractMediaIds(snapshot);
  const current = await tx
    .select({ mediaId: canvasProjectMedia.mediaId })
    .from(canvasProjectMedia)
    .where(eq(canvasProjectMedia.projectId, projectId));
  const visibility = or(
    eq(mediaObjects.ownerId, userId), eq(assets.scope, "public"), eq(assets.ownerId, userId),
    sql`exists (
      select 1 from canvas_project_media cpm join canvas_projects cp on cp.id = cpm.project_id
      where cpm.media_id = ${mediaObjects.id} and cp.user_id = ${userId}::uuid
    )`,
    sql`exists (
      select 1 from canvas_project_history_media hm join canvas_project_history h on h.id = hm.history_id
      where hm.media_id = ${mediaObjects.id} and h.user_id = ${userId}::uuid
    )`,
  );
  const allowed = requestedIds.length
    ? await tx
        .selectDistinct({ id: mediaObjects.id })
        .from(mediaObjects)
        .leftJoin(assets, eq(assets.mediaId, mediaObjects.id))
        .where(
          and(
            inArray(mediaObjects.id, requestedIds),
            visibility,
            eq(mediaObjects.status, "ready"),
          ),
        )
    : [];
  if (allowed.length !== requestedIds.length) throw new Error("CANVAS_MEDIA_FORBIDDEN");

  const currentIds = new Set(current.map((item) => item.mediaId));
  const nextIds = new Set(requestedIds);
  const added = requestedIds.filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !nextIds.has(id));
  if (removed.length) {
    await tx
      .delete(canvasProjectMedia)
      .where(and(eq(canvasProjectMedia.projectId, projectId), inArray(canvasProjectMedia.mediaId, removed)));
    await tx
      .update(mediaObjects)
      .set({ referenceCount: sql`greatest(${mediaObjects.referenceCount} - 1, 0)` })
      .where(inArray(mediaObjects.id, removed));
  }
  if (added.length) {
    const claimed = await tx
      .update(mediaObjects)
      .set({ referenceCount: sql`${mediaObjects.referenceCount} + 1` })
      .where(and(inArray(mediaObjects.id, added), eq(mediaObjects.status, "ready")))
      .returning({ id: mediaObjects.id });
    if (claimed.length !== added.length) throw new Error("CANVAS_MEDIA_FORBIDDEN");
    await tx.insert(canvasProjectMedia).values(added.map((mediaId) => ({ projectId, mediaId })));
  }
  return removed;
}

export async function retainCanvasHistoryMedia(tx: Transaction, historyId: string, projectId: string) {
  await tx.execute(sql`
    with retained as (
      insert into canvas_project_history_media (history_id, media_id)
      select ${historyId}::uuid, media_id from canvas_project_media where project_id = ${projectId}::uuid
      on conflict do nothing
      returning media_id
    )
    update media_objects set reference_count = reference_count + 1
    where id in (select media_id from retained)
  `);
}

export async function releaseCanvasHistoryMedia(tx: Transaction, historyIds: string[]) {
  if (!historyIds.length) return [];
  const released = await tx.execute(sql`
    with released as (
      delete from canvas_project_history_media
      where ${inArray(canvasProjectHistoryMedia.historyId, historyIds)}
      returning media_id
    ), counts as (
      select media_id, count(*)::int as count from released group by media_id
    )
    update media_objects set reference_count = greatest(reference_count - counts.count, 0)
    from counts where media_objects.id = counts.media_id
    returning media_objects.id
  `);
  return released.map((row) => String(row.id));
}

export async function releaseCanvasMedia(tx: Transaction, projectId: string) {
  const current = await tx
    .select({ mediaId: canvasProjectMedia.mediaId })
    .from(canvasProjectMedia)
    .where(eq(canvasProjectMedia.projectId, projectId));
  if (current.length) {
    await tx
      .update(mediaObjects)
      .set({ referenceCount: sql`greatest(${mediaObjects.referenceCount} - 1, 0)` })
      .where(inArray(mediaObjects.id, current.map((item) => item.mediaId)));
  }
  await tx.delete(canvasProjectMedia).where(eq(canvasProjectMedia.projectId, projectId));
  const history = await tx.select({ id: canvasProjectHistory.id }).from(canvasProjectHistory).where(eq(canvasProjectHistory.projectId, projectId));
  const releasedHistory = await releaseCanvasHistoryMedia(tx, history.map((item) => item.id));
  return [...current.map((item) => item.mediaId), ...releasedHistory];
}
