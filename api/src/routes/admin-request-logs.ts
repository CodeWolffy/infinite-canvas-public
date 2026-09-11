import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";
import { requestLogs, users } from "../db/schema.js";

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  userId: z.string().uuid().optional(),
  modelId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  type: z.enum(["image", "text", "probe"]).optional(),
  status: z.enum(["running", "succeeded", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function adminRequestLogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return reply;
  });

  app.get("/", async (request, _reply) => {
    const query = querySchema.parse(request.query);
    const filters: SQL[] = [];
    if (query.from) filters.push(gte(requestLogs.startedAt, new Date(query.from)));
    if (query.to) filters.push(lt(requestLogs.startedAt, new Date(query.to)));
    if (query.userId) filters.push(eq(requestLogs.userId, query.userId));
    if (query.modelId) filters.push(eq(requestLogs.modelId, query.modelId));
    if (query.channelId) filters.push(eq(requestLogs.channelId, query.channelId));
    if (query.type) filters.push(eq(requestLogs.type, query.type));
    if (query.status) filters.push(eq(requestLogs.status, query.status));
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select({
        id: requestLogs.id,
        userId: requestLogs.userId,
        username: users.username,
        userDisplayName: users.displayName,
        type: requestLogs.type,
        taskId: requestLogs.taskId,
        textRequestId: requestLogs.textRequestId,
        modelId: requestLogs.modelId,
        modelNameSnapshot: requestLogs.modelNameSnapshot,
        modelDisplayNameSnapshot: requestLogs.modelDisplayNameSnapshot,
        channelId: requestLogs.channelId,
        channelNameSnapshot: requestLogs.channelNameSnapshot,
        upstreamModel: requestLogs.upstreamModel,
        status: requestLogs.status,
        httpStatus: requestLogs.httpStatus,
        errorCategory: requestLogs.errorCategory,
        errorMessage: requestLogs.errorMessage,
        billedAmount: requestLogs.billedAmount,
        startedAt: requestLogs.startedAt,
        finishedAt: requestLogs.finishedAt,
        durationMs: requestLogs.durationMs,
      })
      .from(requestLogs)
      .leftJoin(users, eq(users.id, requestLogs.userId))
      .where(where)
      .orderBy(desc(requestLogs.startedAt))
      .limit(query.limit)
      .offset(query.offset);
    const [totals] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(requestLogs)
      .where(where);
    return { logs: rows, total: totals?.total ?? 0 };
  });

  app.delete("/", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const result = await db.delete(requestLogs).returning({ id: requestLogs.id });
    return { deleted: result.length };
  });
}
