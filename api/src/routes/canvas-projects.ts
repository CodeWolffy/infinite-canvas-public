import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";
import { canvasProjects, canvasProjectHistory } from "../db/schema.js";
import { removeUnreferencedMedia } from "../media-cleanup.js";
import { releaseCanvasHistoryMedia, releaseCanvasMedia, retainCanvasHistoryMedia, syncCanvasMedia } from "../media-references.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const paramsSchema = z.object({ id: z.string().uuid() });
const historyParamsSchema = z.object({ id: z.string().uuid(), historyId: z.string().uuid() });
const createBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    snapshot: z.unknown(),
  })
  .refine((body) => body.snapshot !== undefined, { path: ["snapshot"], message: "snapshot 必填" });
const updateBody = z
  .object({ title: z.string().trim().min(1).max(200).optional(), snapshot: z.unknown().optional() })
  .refine((body) => Object.keys(body).length > 0);

const MAX_HISTORY_PER_PROJECT = 20;
const AUTO_BACKUP_INTERVAL_MS = 5 * 60 * 1000;

async function trimHistory(tx: Transaction, projectId: string) {
  const expired = await tx
    .select({ id: canvasProjectHistory.id })
    .from(canvasProjectHistory)
    .where(eq(canvasProjectHistory.projectId, projectId))
    .orderBy(desc(canvasProjectHistory.createdAt), desc(canvasProjectHistory.id))
    .offset(MAX_HISTORY_PER_PROJECT);
  if (!expired.length) return [];
  const ids = expired.map((item) => item.id);
  const mediaIds = await releaseCanvasHistoryMedia(tx, ids);
  await tx.delete(canvasProjectHistory).where(inArray(canvasProjectHistory.id, ids));
  return mediaIds;
}

/**
 * 自动备份：仅在「忽略视口后内容确实变化」且「距上次自动备份超过 5 分钟」时才写一份快照。
 * 以前每次保存（包括只拖动视口）都会复制一份完整快照，画布越大写放大越严重。
 * 判断与拷贝都在库内完成，旧快照不会回传到 Node。
 */
async function autoBackupSnapshot(tx: Transaction, projectId: string, userId: string, nextSnapshot: unknown) {
  const [recent] = await tx
    .select({ id: canvasProjectHistory.id })
    .from(canvasProjectHistory)
    .where(
      and(
        eq(canvasProjectHistory.projectId, projectId),
        isNull(canvasProjectHistory.note),
        gt(canvasProjectHistory.createdAt, new Date(Date.now() - AUTO_BACKUP_INTERVAL_MS)),
      ),
    )
    .limit(1);
  if (recent) return;
  const [inserted] = await tx.execute(sql`
    insert into canvas_project_history (project_id, user_id, title, snapshot)
    select cp.id, ${userId}::uuid, cp.title, cp.snapshot
    from canvas_projects cp
    where cp.id = ${projectId}::uuid
      and (cp.snapshot - 'viewport') is distinct from (${JSON.stringify(nextSnapshot)}::jsonb - 'viewport')
    returning id
  `);
  if (inserted) await retainCanvasHistoryMedia(tx, String(inserted.id), projectId);
}

export async function canvasProjectRoutes(app: FastifyInstance) {
  app.get("/", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    // 列表只下发元数据与规模统计，避免把每个项目的完整快照都传给前端。
    const projects = await db
      .select({
        id: canvasProjects.id,
        title: canvasProjects.title,
        createdAt: canvasProjects.createdAt,
        updatedAt: canvasProjects.updatedAt,
        nodeCount: sql<number>`coalesce(jsonb_array_length((${canvasProjects.snapshot}->'nodes')::jsonb), 0)::int`,
        connectionCount: sql<number>`coalesce(jsonb_array_length((${canvasProjects.snapshot}->'connections')::jsonb), 0)::int`,
      })
      .from(canvasProjects)
      .where(eq(canvasProjects.userId, user.id))
      .orderBy(desc(canvasProjects.updatedAt));
    return { projects };
  });

  app.get("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const [project] = await db
      .select()
      .from(canvasProjects)
      .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)))
      .limit(1);
    if (!project) return reply.code(404).send({ error: "not_found", message: "画布项目不存在" });
    return { project };
  });

  app.post("/", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = createBody.parse(request.body);
    const placeholder = { nodes: [], connections: [], chatSessions: [], activeChatId: null };
    try {
      const saved = await db.transaction(async (tx) => {
        const [project] = await tx
          .insert(canvasProjects)
          .values({ userId: user.id, title: body.title, snapshot: placeholder })
          .returning();
        await syncCanvasMedia(tx, project!.id, user.id, body.snapshot);
        const [result] = await tx
          .update(canvasProjects)
          .set({ snapshot: body.snapshot, updatedAt: new Date() })
          .where(eq(canvasProjects.id, project!.id))
          .returning();
        return result;
      });
      return reply.code(201).send({ project: saved });
    } catch (error) {
      if (error instanceof Error && error.message === "CANVAS_MEDIA_FORBIDDEN") {
        return reply.code(400).send({ error: "invalid_media", message: "画布包含无权访问的文件" });
      }
      throw error;
    }
  });

  app.put("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const body = updateBody.parse(request.body);
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}::uuid::text, 0))`);
        const [existing] = await tx
          .select({ id: canvasProjects.id })
          .from(canvasProjects)
          .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)))
          .limit(1);
        if (!existing) return undefined;

        if (body.snapshot !== undefined) await autoBackupSnapshot(tx, id, user.id, body.snapshot);

        const removedIds = body.snapshot !== undefined ? await syncCanvasMedia(tx, id, user.id, body.snapshot) : [];
        if (body.snapshot !== undefined) removedIds.push(...await trimHistory(tx, id));
        const [saved] = await tx
          .update(canvasProjects)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(canvasProjects.id, id))
          .returning({
            id: canvasProjects.id,
            title: canvasProjects.title,
            createdAt: canvasProjects.createdAt,
            updatedAt: canvasProjects.updatedAt,
          });
        return { project: saved, removedIds };
      });
      if (!result) return reply.code(404).send({ error: "not_found", message: "画布项目不存在" });
      await removeUnreferencedMedia(result.removedIds, (error, mediaId) => app.log.error({ err: error, mediaId }, "清理画布无引用媒体失败"));
      return { project: result.project };
    } catch (error) {
      if (error instanceof Error && error.message === "CANVAS_MEDIA_FORBIDDEN") {
        return reply.code(400).send({ error: "invalid_media", message: "画布包含无权访问的文件" });
      }
      throw error;
    }
  });

const createSnapshotBody = z.object({ note: z.string().trim().max(200).optional() });

  app.get("/:id/history", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const history = await db
      .select({
        id: canvasProjectHistory.id,
        title: canvasProjectHistory.title,
        note: canvasProjectHistory.note,
        createdAt: canvasProjectHistory.createdAt,
        nodeCount: sql<number>`coalesce(jsonb_array_length((${canvasProjectHistory.snapshot}->'nodes')::jsonb), 0)::int`,
        connectionCount: sql<number>`coalesce(jsonb_array_length((${canvasProjectHistory.snapshot}->'connections')::jsonb), 0)::int`,
      })
      .from(canvasProjectHistory)
      .where(and(eq(canvasProjectHistory.projectId, id), eq(canvasProjectHistory.userId, user.id)))
      .orderBy(desc(canvasProjectHistory.createdAt), desc(canvasProjectHistory.id))
      .limit(MAX_HISTORY_PER_PROJECT);
    return { history };
  });

  app.post("/:id/history", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const body = createSnapshotBody.parse(request.body ?? {});
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}::uuid::text, 0))`);
      const [project] = await tx
        .select({ id: canvasProjects.id })
        .from(canvasProjects)
        .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)))
        .limit(1);
      if (!project) return undefined;
      // 直接在库内拷贝当前快照，避免把整份 snapshot 拉进 Node 再写回去。
      const [row] = await tx.execute(sql`
        insert into canvas_project_history (project_id, user_id, title, note, snapshot)
        select cp.id, ${user.id}::uuid, cp.title, ${body.note?.trim() || null}, cp.snapshot
        from canvas_projects cp
        where cp.id = ${id}::uuid
        returning id, title, note, created_at,
          coalesce(jsonb_array_length((snapshot->'nodes')::jsonb), 0)::int as node_count,
          coalesce(jsonb_array_length((snapshot->'connections')::jsonb), 0)::int as connection_count
      `);
      if (!row) return undefined;
      await retainCanvasHistoryMedia(tx, String(row.id), id);
      const removedIds = await trimHistory(tx, id);
      return { saved: row, removedIds };
    });
    if (!result) return reply.code(404).send({ error: "not_found", message: "画布项目不存在" });
    await removeUnreferencedMedia(result.removedIds, (error, mediaId) => app.log.error({ err: error, mediaId }, "清理历史无引用媒体失败"));
    const { saved } = result;
    return reply.code(201).send({
      history: {
        id: saved.id,
        title: saved.title,
        note: saved.note,
        createdAt: saved.created_at,
        nodeCount: Number(saved.node_count ?? 0),
        connectionCount: Number(saved.connection_count ?? 0),
      },
    });
  });

  app.post("/:id/history/:historyId/restore", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id, historyId } = historyParamsSchema.parse(request.params);
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}::uuid::text, 0))`);
        const [historyItem] = await tx
          .select()
          .from(canvasProjectHistory)
          .where(and(eq(canvasProjectHistory.id, historyId), eq(canvasProjectHistory.projectId, id), eq(canvasProjectHistory.userId, user.id)))
          .limit(1);
        if (!historyItem) return undefined;
        const [current] = await tx
          .select({ id: canvasProjects.id })
          .from(canvasProjects)
          .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)))
          .limit(1);
        if (!current) return undefined;

        // 还原是破坏性操作，无论间隔多久都先把当前版本备份一份。
        const [backup] = await tx.execute(sql`
          insert into canvas_project_history (project_id, user_id, title, snapshot)
          select cp.id, ${user.id}::uuid, cp.title, cp.snapshot
          from canvas_projects cp
          where cp.id = ${id}::uuid
          returning id
        `);
        if (backup) await retainCanvasHistoryMedia(tx, String(backup.id), id);

        const removedIds = await syncCanvasMedia(tx, id, user.id, historyItem.snapshot);
        removedIds.push(...await trimHistory(tx, id));
        const [saved] = await tx
          .update(canvasProjects)
          .set({ title: historyItem.title, snapshot: historyItem.snapshot, updatedAt: new Date() })
          .where(eq(canvasProjects.id, id))
          .returning();
        return { project: saved, removedIds };
      });
      if (!result) return reply.code(404).send({ error: "not_found", message: "历史版本或画布不存在" });
      await removeUnreferencedMedia(result.removedIds, (error, mediaId) => app.log.error({ err: error, mediaId }, "清理画布无引用媒体失败"));
      return { project: result.project };
    } catch (error) {
      if (error instanceof Error && error.message === "CANVAS_MEDIA_FORBIDDEN") {
        return reply.code(400).send({ error: "invalid_media", message: "历史快照包含无权访问的文件" });
      }
      throw error;
    }
  });

  app.delete("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const deletion = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}::uuid::text, 0))`);
      const [project] = await tx
        .select({ id: canvasProjects.id })
        .from(canvasProjects)
        .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)))
        .limit(1);
      if (!project) return undefined;
      const removedIds = await releaseCanvasMedia(tx, id);
      await tx.delete(canvasProjects).where(eq(canvasProjects.id, id));
      return removedIds;
    });
    if (!deletion) return reply.code(404).send({ error: "not_found", message: "画布项目不存在" });
    await removeUnreferencedMedia(deletion, (error, mediaId) => app.log.error({ err: error, mediaId }, "清理画布无引用媒体失败"));
    return reply.code(204).send();
  });
}
