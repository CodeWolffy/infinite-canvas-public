import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";
import { channels, modelChannels, models } from "../db/schema.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const bindingParams = z.object({ id: z.string().uuid(), channelId: z.string().uuid() });
const decimal = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().nonnegative()]).nullable();
const modelBody = z.object({
  name: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(120),
  capability: z.enum(["image", "text"]),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  status: z.enum(["draft", "published", "disabled"]).default("draft"),
  pricePerImage: decimal.optional(),
  description: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});
const updateModelBody = modelBody.partial().refine((body) => Object.keys(body).length > 0);
const statusBody = z.object({ status: z.enum(["draft", "published", "disabled"]) });
const bindingBody = z.object({
  upstreamModel: z.string().trim().min(1).max(160),
  priority: z.number().int().default(0),
  weight: z.number().int().positive().default(100),
  enabled: z.boolean().default(true),
});

function normalizeModelValues<T extends { pricePerImage?: string | number | null }>(body: T) {
  return {
    ...body,
    ...(body.pricePerImage !== undefined && {
      pricePerImage: body.pricePerImage === null ? null : String(body.pricePerImage),
    }),
  };
}

export async function adminModelRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return reply;
  });

  app.get("/", async (_request, _reply) => {
    return { models: await db.select().from(models).where(isNull(models.deletedAt)).orderBy(asc(models.sortOrder), asc(models.displayName)) };
  });

  app.get("/:id", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const [model] = await db.select().from(models).where(and(eq(models.id, id), isNull(models.deletedAt))).limit(1);
    if (!model) return reply.code(404).send({ error: "not_found", message: "模型不存在" });
    return { model };
  });

  app.post("/", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const body = normalizeModelValues(modelBody.parse(request.body));
    const [model] = await db.insert(models).values(body).returning();
    return reply.code(201).send({ model });
  });

  app.put("/:id", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const body = normalizeModelValues(updateModelBody.parse(request.body));
    const [model] = await db
      .update(models)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(models.id, id), isNull(models.deletedAt)))
      .returning();
    if (!model) return reply.code(404).send({ error: "not_found", message: "模型不存在" });
    return { model };
  });

  app.patch("/:id/status", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const { status } = statusBody.parse(request.body);
    const [model] = await db
      .update(models)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(models.id, id), isNull(models.deletedAt)))
      .returning();
    if (!model) return reply.code(404).send({ error: "not_found", message: "模型不存在" });
    return { model };
  });

  app.delete("/:id", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const model = await db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(models)
        .set({ status: "disabled", deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(models.id, id), isNull(models.deletedAt)))
        .returning({ id: models.id });
      if (!deleted) return undefined;
      await tx.delete(modelChannels).where(eq(modelChannels.modelId, id));
      return deleted;
    });
    if (!model) return reply.code(404).send({ error: "not_found", message: "模型不存在" });
    return reply.code(204).send();
  });

  app.get("/:id/channels", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const bindings = await db
      .select({
        modelId: modelChannels.modelId,
        channelId: modelChannels.channelId,
        channelName: channels.name,
        channelStatus: channels.status,
        upstreamModel: modelChannels.upstreamModel,
        priority: modelChannels.priority,
        weight: modelChannels.weight,
        enabled: modelChannels.enabled,
        createdAt: modelChannels.createdAt,
        updatedAt: modelChannels.updatedAt,
      })
      .from(modelChannels)
      .innerJoin(channels, eq(channels.id, modelChannels.channelId))
      .where(eq(modelChannels.modelId, id));
    return { bindings };
  });

  app.put("/:id/channels/:channelId", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id, channelId } = bindingParams.parse(request.params);
    const body = bindingBody.parse(request.body);
    const [binding] = await db
      .insert(modelChannels)
      .values({ modelId: id, channelId, ...body })
      .onConflictDoUpdate({
        target: [modelChannels.modelId, modelChannels.channelId],
        set: { ...body, updatedAt: new Date() },
      })
      .returning();
    return { binding };
  });

  app.delete("/:id/channels/:channelId", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id, channelId } = bindingParams.parse(request.params);
    const [binding] = await db
      .delete(modelChannels)
      .where(and(eq(modelChannels.modelId, id), eq(modelChannels.channelId, channelId)))
      .returning({ modelId: modelChannels.modelId });
    if (!binding) return reply.code(404).send({ error: "not_found", message: "模型渠道绑定不存在" });
    return reply.code(204).send();
  });
}
