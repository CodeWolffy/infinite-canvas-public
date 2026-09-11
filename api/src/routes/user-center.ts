import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";
import {
  assets,
  canvasProjects,
  generationTasks,
  mediaObjects,
  requestLogs,
  textRequests,
  users,
} from "../db/schema.js";

const profileBody = z.object({
  displayName: z.string().trim().min(1).max(80),
});

const logsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  type: z.enum(["image", "text", "probe"]).optional(),
  status: z.enum(["running", "succeeded", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function userCenterRoutes(app: FastifyInstance) {
  app.get("/stats", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;

    const [imageTasks] = await db
      .select({
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where status = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where status = 'failed' or status = 'canceled')::int`,
        active: sql<number>`count(*) filter (where status = 'queued' or status = 'running')::int`,
      })
      .from(generationTasks)
      .where(eq(generationTasks.userId, user.id));

    const [textStats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where status = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where status = 'failed')::int`,
      })
      .from(textRequests)
      .where(eq(textRequests.userId, user.id));

    const [storageStats] = await db
      .select({
        totalCount: sql<number>`count(*)::int`,
        totalBytes: sql<number>`coalesce(sum(byte_size), 0)::float8`,
      })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.ownerId, user.id), eq(mediaObjects.status, "ready")));

    const [canvasStats] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(canvasProjects)
      .where(eq(canvasProjects.userId, user.id));

    const [assetStats] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(assets)
      .where(eq(assets.ownerId, user.id));

    return {
      stats: {
        images: {
          total: imageTasks?.total ?? 0,
          succeeded: imageTasks?.succeeded ?? 0,
          failed: imageTasks?.failed ?? 0,
          active: imageTasks?.active ?? 0,
        },
        text: {
          total: textStats?.total ?? 0,
          succeeded: textStats?.succeeded ?? 0,
          failed: textStats?.failed ?? 0,
        },
        storage: {
          totalCount: storageStats?.totalCount ?? 0,
          totalBytes: storageStats?.totalBytes ?? 0,
        },
        canvasCount: canvasStats?.count ?? 0,
        assetCount: assetStats?.count ?? 0,
      },
    };
  });

  app.get("/logs", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const query = logsQuerySchema.parse(request.query);
    const filters: SQL[] = [eq(requestLogs.userId, user.id)];

    if (query.from) filters.push(gte(requestLogs.startedAt, new Date(query.from)));
    if (query.to) filters.push(lt(requestLogs.startedAt, new Date(query.to)));
    if (query.type) filters.push(eq(requestLogs.type, query.type));
    if (query.status) filters.push(eq(requestLogs.status, query.status));

    const where = and(...filters);

    const rows = await db
      .select({
        id: requestLogs.id,
        type: requestLogs.type,
        taskId: requestLogs.taskId,
        textRequestId: requestLogs.textRequestId,
        modelDisplayName: requestLogs.modelDisplayNameSnapshot,
        status: requestLogs.status,
        httpStatus: requestLogs.httpStatus,
        errorCategory: requestLogs.errorCategory,
        errorMessage: requestLogs.errorMessage,
        startedAt: requestLogs.startedAt,
        finishedAt: requestLogs.finishedAt,
        durationMs: requestLogs.durationMs,
      })
      .from(requestLogs)
      .where(where)
      .orderBy(desc(requestLogs.startedAt))
      .limit(query.limit)
      .offset(query.offset);

    const [totalRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(requestLogs)
      .where(where);

    return {
      logs: rows,
      total: totalRow?.count ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.patch("/profile", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = profileBody.parse(request.body);

    const [updated] = await db
      .update(users)
      .set({
        displayName: body.displayName,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();

    if (!updated) {
      return reply.code(404).send({ error: "user_not_found", message: "用户不存在" });
    }

    return {
      user: {
        id: updated.id,
        username: updated.username,
        displayName: updated.displayName,
        role: updated.role,
        status: updated.status,
        mustChangePassword: updated.mustChangePassword,
        lastLoginAt: updated.lastLoginAt,
        createdAt: updated.createdAt,
      },
    };
  });
}
