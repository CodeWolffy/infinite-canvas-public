import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";
import { assets, mediaObjects } from "../db/schema.js";
import { removeUnreferencedMedia } from "../media-cleanup.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  scope: z.enum(["private", "public", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const assetFields = z.object({
  scope: z.enum(["private", "public"]).default("private"),
  type: z.enum(["image", "text"]),
  title: z.string().trim().min(1).max(200),
  content: z.string().nullable().optional(),
  mediaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const assetBody = assetFields
  .superRefine((body, context) => {
    if (body.type === "image" && !body.mediaId) {
      context.addIssue({ code: "custom", path: ["mediaId"], message: "图片素材必须指定 mediaId" });
    }
    if (body.type === "text" && !body.content?.trim()) {
      context.addIssue({ code: "custom", path: ["content"], message: "文本素材必须包含正文" });
    }
  });
const updateBody = assetFields.partial().refine((body) => Object.keys(body).length > 0);

async function assertUsableMedia(mediaId: string | null | undefined, ownerIds: string[]) {
  if (!mediaId) return;
  const [media] = await db
    .selectDistinct({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.id, mediaId),
        inArray(mediaObjects.ownerId, ownerIds),
        eq(mediaObjects.status, "ready"),
      ),
    )
    .limit(1);
  if (!media) throw new Error("MEDIA_NOT_OWNED");
}

export async function assetRoutes(app: FastifyInstance) {
  app.get("/", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { scope, limit, offset } = listQuery.parse(request.query);
    const visibility =
      scope === "private"
        ? and(eq(assets.ownerId, user.id), eq(assets.scope, "private"))
        : scope === "public"
          ? eq(assets.scope, "public")
          : or(eq(assets.ownerId, user.id), eq(assets.scope, "public"));
    // updatedAt 会有并列值，补 id 作为次级排序键，否则翻页时可能漏条或重复。
    const result = await db
      .select()
      .from(assets)
      .where(visibility)
      .orderBy(desc(assets.updatedAt), desc(assets.id))
      .limit(limit)
      .offset(offset);
    return { assets: result };
  });

  app.get("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!asset) return reply.code(404).send({ error: "not_found", message: "素材不存在" });
    if (asset.scope !== "public" && asset.ownerId !== user.id && user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden", message: "无权访问该素材" });
    }
    return { asset };
  });

  app.post("/", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = assetBody.parse(request.body);
    try {
      await assertUsableMedia(body.mediaId, [user.id]);
    } catch {
      return reply.code(400).send({ error: "invalid_media", message: "文件不存在或不属于当前用户" });
    }
    try {
      const [asset] = await db.transaction(async (tx) => {
        if (body.mediaId) {
          const [claimed] = await tx
            .update(mediaObjects)
            .set({ referenceCount: sql`${mediaObjects.referenceCount} + 1` })
            .where(and(eq(mediaObjects.id, body.mediaId), eq(mediaObjects.status, "ready")))
            .returning({ id: mediaObjects.id });
          if (!claimed) throw new Error("MEDIA_NOT_OWNED");
        }
        return tx.insert(assets).values({ ownerId: user.id, ...body }).returning();
      });
      return reply.code(201).send({ asset });
    } catch (error) {
      if (error instanceof Error && error.message === "MEDIA_NOT_OWNED") {
        return reply.code(400).send({ error: "invalid_media", message: "文件不存在或不属于当前用户" });
      }
      throw error;
    }
  });

  app.put("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const body = updateBody.parse(request.body);
    const [current] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!current) return reply.code(404).send({ error: "not_found", message: "素材不存在" });
    if (current.ownerId !== user.id && !(user.role === "admin" && current.scope === "public")) {
      return reply.code(403).send({ error: "forbidden", message: "无权修改该素材" });
    }
    if (current.ownerId !== user.id && body.scope === "private") {
      return reply.code(403).send({ error: "forbidden", message: "管理员不能把他人的公共素材改为私人素材" });
    }
    assetBody.parse({ ...current, ...body });
    if (body.mediaId !== undefined && body.mediaId !== current.mediaId) {
      try {
        await assertUsableMedia(body.mediaId, user.role === "admin" ? [current.ownerId, user.id] : [current.ownerId]);
      } catch {
        return reply.code(400).send({ error: "invalid_media", message: "文件不存在或无权用于该素材" });
      }
    }
    try {
      const result = await db.transaction(async (tx) => {
        const removedMediaId = body.mediaId !== undefined && body.mediaId !== current.mediaId ? current.mediaId : null;
        if (body.mediaId !== undefined && body.mediaId !== current.mediaId) {
          if (current.mediaId) {
            await tx
              .update(mediaObjects)
              .set({ referenceCount: sql`greatest(${mediaObjects.referenceCount} - 1, 0)` })
              .where(eq(mediaObjects.id, current.mediaId));
          }
          if (body.mediaId) {
            const [claimed] = await tx
              .update(mediaObjects)
              .set({ referenceCount: sql`${mediaObjects.referenceCount} + 1` })
              .where(and(eq(mediaObjects.id, body.mediaId), eq(mediaObjects.status, "ready")))
              .returning({ id: mediaObjects.id });
            if (!claimed) throw new Error("MEDIA_NOT_OWNED");
          }
        }
        const [asset] = await tx
          .update(assets)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(assets.id, id))
          .returning();
        return { asset, removedMediaId };
      });
      if (result.removedMediaId) await removeUnreferencedMedia([result.removedMediaId], (error, mediaId) => app.log.error({ err: error, mediaId }, "清理素材无引用媒体失败"));
      return { asset: result.asset };
    } catch (error) {
      if (error instanceof Error && error.message === "MEDIA_NOT_OWNED") {
        return reply.code(400).send({ error: "invalid_media", message: "文件不存在或无权用于该素材" });
      }
      throw error;
    }
  });

  app.delete("/:id", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const [current] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!current) return reply.code(404).send({ error: "not_found", message: "素材不存在" });
    if (current.ownerId !== user.id && !(user.role === "admin" && current.scope === "public")) {
      return reply.code(403).send({ error: "forbidden", message: "无权删除该素材" });
    }
    await db.transaction(async (tx) => {
      await tx.delete(assets).where(eq(assets.id, id));
      if (current.mediaId) {
        await tx
          .update(mediaObjects)
          .set({ referenceCount: sql`greatest(${mediaObjects.referenceCount} - 1, 0)` })
          .where(eq(mediaObjects.id, current.mediaId));
      }
    });
    if (current.mediaId) await removeUnreferencedMedia([current.mediaId], (error, mediaId) => app.log.error({ err: error, mediaId }, "清理素材无引用媒体失败"));
    return reply.code(204).send();
  });
}
