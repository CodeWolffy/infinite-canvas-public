import type { FastifyInstance } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { decryptSecret, encryptSecret, secretHint } from "../crypto.js";
import { db } from "../db/client.js";
import { channels } from "../db/schema.js";
import { finishRequestLog, startRequestLog } from "../request-logs.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const channelBody = z.object({
  name: z.string().trim().min(1).max(120),
  protocol: z.enum(["openai", "gemini"]),
  baseUrl: z.string().url().refine((value) => /^https?:/.test(value)),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  status: z.enum(["active", "disabled", "needs_attention"]).default("disabled"),
  timeoutMs: z.number().int().min(1000).max(600000).default(480000),
  maxConcurrency: z.number().int().min(1).max(20).default(1),
  cooldownSeconds: z.number().int().min(0).max(86400).default(120),
});
const updateChannelBody = channelBody.partial().refine((body) => Object.keys(body).length > 0);
type ChannelInput = z.infer<typeof channelBody>;
type ChannelUpdate = z.infer<typeof updateChannelBody>;

function publicChannel(channel: typeof channels.$inferSelect) {
  const { encryptedApiKey: _encryptedApiKey, ...safe } = channel;
  return { ...safe, apiKeyConfigured: Boolean(channel.encryptedApiKey) };
}

function channelValues(body: ChannelInput): typeof channels.$inferInsert;
function channelValues(body: ChannelUpdate): Partial<typeof channels.$inferInsert>;
function channelValues(body: ChannelUpdate): Partial<typeof channels.$inferInsert> {
  const { apiKey, ...values } = body;
  return {
    ...values,
    ...(body.status === "active" ? { cooldownUntil: null } : {}),
    ...(apiKey && {
      encryptedApiKey: encryptSecret(apiKey),
      apiKeyHint: secretHint(apiKey),
    }),
  };
}

function modelsUrl(baseUrl: string, protocol: "openai" | "gemini") {
  let base = baseUrl.replace(/\/$/, "");
  if (protocol === "gemini" && !base.includes("/v1beta") && !base.includes("/v1")) {
    base = `${base}/v1beta`;
  }
  return new URL(`${base}/models`);
}

function extractModelNames(value: unknown) {
  if (!value || typeof value !== "object") return [];
  const list = Array.isArray((value as { data?: unknown }).data)
    ? (value as { data: unknown[] }).data
    : Array.isArray((value as { models?: unknown }).models)
      ? (value as { models: unknown[] }).models
      : [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const value = (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name;
      return typeof value === "string" ? value.replace(/^models\//, "") : null;
    })
    .filter((name): name is string => Boolean(name));
}

export async function adminChannelRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return reply;
  });

  app.get("/", async (_request, _reply) => {
    const result = await db.select().from(channels).orderBy(asc(channels.name));
    const attempts = await db.execute(sql`
      select distinct on (channel_id)
        channel_id, status, duration_ms, http_status, error_category, error_message,
        upstream_model, started_at, finished_at
      from generation_attempts
      order by channel_id, started_at desc
    `);
    const attemptsByChannel = new Map(attempts.map((attempt) => [attempt.channel_id, attempt]));
    return {
      channels: result.map((channel) => {
        const attempt = attemptsByChannel.get(channel.id);
        return {
          ...publicChannel(channel),
          lastAttempt: attempt
            ? {
                status: attempt.status,
                durationMs: attempt.duration_ms,
                httpStatus: attempt.http_status,
                errorCategory: attempt.error_category,
                errorMessage: attempt.error_message,
                upstreamModel: attempt.upstream_model,
                startedAt: attempt.started_at,
                finishedAt: attempt.finished_at,
              }
            : null,
        };
      }),
    };
  });

  app.get("/:id", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const [channel] = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
    if (!channel) return reply.code(404).send({ error: "not_found", message: "渠道不存在" });
    return { channel: publicChannel(channel) };
  });

  app.post("/", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const body = channelBody.parse(request.body);
    const [channel] = await db.insert(channels).values(channelValues(body)).returning();
    return reply.code(201).send({ channel: publicChannel(channel!) });
  });

  app.put("/:id", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const body = updateChannelBody.parse(request.body);
    const [channel] = await db
      .update(channels)
      .set({ ...channelValues(body), updatedAt: new Date() })
      .where(eq(channels.id, id))
      .returning();
    if (!channel) return reply.code(404).send({ error: "not_found", message: "渠道不存在" });
    return { channel: publicChannel(channel) };
  });

  app.delete("/:id", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const [channel] = await db.delete(channels).where(eq(channels.id, id)).returning({ id: channels.id });
    if (!channel) return reply.code(404).send({ error: "not_found", message: "渠道不存在" });
    return reply.code(204).send();
  });

  app.patch("/:id/status", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const { status } = z.object({ status: z.enum(["active", "disabled", "needs_attention"]) }).parse(request.body);
    const [channel] = await db
      .update(channels)
      .set({ status, ...(status === "active" ? { cooldownUntil: null } : {}), updatedAt: new Date() })
      .where(eq(channels.id, id))
      .returning();
    if (!channel) return reply.code(404).send({ error: "not_found", message: "渠道不存在" });
    return { channel: publicChannel(channel) };
  });

  app.post("/:id/models", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = paramsSchema.parse(request.params);
    const [channel] = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
    if (!channel) return reply.code(404).send({ error: "not_found", message: "渠道不存在" });

    const apiKey = channel.encryptedApiKey ? decryptSecret(channel.encryptedApiKey) : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(channel.timeoutMs, 30000));
    const requestLogId = await startRequestLog({
      userId: admin.id,
      type: "probe",
      channelId: channel.id,
      channelNameSnapshot: channel.name,
    });
    try {
      const headers: Record<string, string> = {};
      if (channel.protocol === "openai" && apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (channel.protocol === "gemini" && apiKey) {
        headers["x-goog-api-key"] = apiKey;
        if (apiKey.startsWith("sk-")) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
      }
      const response = await fetch(modelsUrl(channel.baseUrl, channel.protocol), {
        headers: Object.keys(headers).length ? headers : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        await db
          .update(channels)
          .set({
            lastFailureAt: new Date(),
            lastErrorCode: `HTTP_${response.status}`,
            status: response.status === 401 || response.status === 403 ? "needs_attention" : channel.status,
            updatedAt: new Date(),
          })
          .where(eq(channels.id, id));
        await finishRequestLog(requestLogId, { httpStatus: response.status, category: `HTTP_${response.status}`, message: `上游返回 HTTP ${response.status}` });
        return reply.code(502).send({ error: "upstream_error", message: `上游返回 HTTP ${response.status}` });
      }
      const modelNames = extractModelNames(await response.json());
      const checkedAt = new Date();
      await db
        .update(channels)
        .set({ lastSuccessAt: checkedAt, lastErrorCode: null, updatedAt: checkedAt })
        .where(eq(channels.id, id));
      await finishRequestLog(requestLogId);
      return { models: modelNames, health: { ok: true, checkedAt } };
    } catch (error) {
      const checkedAt = new Date();
      await db
        .update(channels)
        .set({ lastFailureAt: checkedAt, lastErrorCode: "NETWORK_ERROR", updatedAt: checkedAt })
        .where(eq(channels.id, id));
      await finishRequestLog(requestLogId, { category: error instanceof Error && error.name === "AbortError" ? "timeout" : "NETWORK_ERROR", message: "无法连接上游渠道" });
      return reply.code(502).send({ error: "upstream_unavailable", message: "无法连接上游渠道" });
    } finally {
      clearTimeout(timeout);
    }
  });
}
