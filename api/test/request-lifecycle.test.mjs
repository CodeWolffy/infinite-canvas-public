import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { after, beforeEach, mock, test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.ts";
import { createTestDatabase } from "./helpers/database.mjs";

const { client, db } = await createTestDatabase();
const userId = randomUUID(), textModelId = randomUUID(), imageModelId = randomUUID(), channelId = randomUUID();
const candidate = { channelId, channelName: "test", upstreamModel: "text-test" };
let calls = [], mediaReads = [], failText = false, paused, entered;
class UpstreamError extends Error { constructor(message, category) { super(message); this.category = category; } }
mock.module("../src/db/client.ts", { namedExports: { db } });
mock.module("../src/auth/session.ts", { namedExports: { authenticate: async () => ({ id: userId }) } });
mock.module("../src/config.ts", { namedExports: { config: { MAX_UPLOAD_BYTES: 50 * 1024 * 1024, ORPHAN_MEDIA_GRACE_DAYS: 45 } } });
mock.module("../src/channel-scheduler.ts", { namedExports: {
  hasChannelCandidates: async () => true,
  runWithFailover: async (_modelId, action) => ({ result: await action(candidate), candidate }),
  UpstreamError,
} });
mock.module("../src/upstream.ts", { namedExports: {
  generateText: async (_candidate, messages) => {
    calls.push(messages);
    entered?.();
    await paused;
    if (failText) throw new UpstreamError("test failure", "test_failure");
    return "saved answer";
  },
  readStreamWithLimit: async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); },
} });
mock.module("../src/media.ts", { namedExports: { minio: { getObject: async (_bucket, key) => { mediaReads.push(key); return Readable.from([Buffer.from(key)]); } } } });
mock.module("../src/generation-worker.ts", { namedExports: { enqueueGenerationTask: async () => {} } });
mock.module("../src/media-cleanup.ts", { namedExports: { removeUnreferencedMedia: async () => {} } });
const { textRoutes } = await import("../src/routes/text.ts");
const { generationBatchRoutes } = await import("../src/routes/generation-batches.ts");
const app = Fastify();
await app.register(textRoutes, { prefix: "/api/text" });
await app.register(generationBatchRoutes, { prefix: "/api/generation-batches" });

beforeEach(async () => {
  await client.exec("truncate users, models, channels cascade");
  await db.insert(schema.users).values({ id: userId, username: "test", displayName: "Test", passwordHash: "test" });
  await db.insert(schema.models).values([
    { id: textModelId, name: "text", displayName: "Text", capability: "text", status: "published" },
    { id: imageModelId, name: "image", displayName: "Image", capability: "image", status: "published", pricePerImage: "1" },
  ]);
  await db.insert(schema.channels).values({ id: channelId, name: "test", protocol: "openai", baseUrl: "https://invalid.invalid" });
  calls = []; mediaReads = []; failText = false; paused = undefined; entered = undefined;
});
after(async () => { await app.close(); await client.close(); });
const sendText = (input) => app.inject({ method: "POST", url: "/api/text/requests", payload: { modelId: textModelId, content: "question", ...input } });

test("text retries claim the request once and do not duplicate messages", async () => {
  const requestId = randomUUID();
  failText = true;
  const initial = await sendText({ requestId });
  assert.equal(initial.statusCode, 502);
  const conversationId = initial.json().conversationId;
  failText = false; calls = [];
  let release;
  paused = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const responses = Promise.all(Array.from({ length: 3 }, () => sendText({ requestId, conversationId })));
  await started;
  release();
  const results = await responses;
  assert.equal(calls.length, 1);
  assert.ok(results.every((response) => [200, 409].includes(response.statusCode)));
  const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
});

test("changed payload cannot reuse a failed text request", async () => {
  const requestId = randomUUID();
  failText = true;
  assert.equal((await sendText({ requestId })).statusCode, 502);
  failText = false; calls = [];
  const response = await sendText({ requestId, content: "different prompt" });
  assert.equal(response.statusCode, 409);
  assert.equal(calls.length, 0);
});

test("follow-up text retains historical images in their original order and system role", async () => {
  const attachmentMediaIds = [randomUUID(), randomUUID()];
  await db.insert(schema.mediaObjects).values(attachmentMediaIds.map((id) => ({ id, ownerId: userId, bucket: "test", objectKey: id, originalName: "image.png", mimeType: "image/png", byteSize: 36, sha256: id })));
  const first = await sendText({ requestId: randomUUID(), attachmentMediaIds, systemPrompt: "system instruction" });
  assert.equal(first.statusCode, 200);
  assert.equal(calls[0][0].role, "system");
  assert.equal(calls[0][0].content, "system instruction");
  const next = await sendText({ requestId: randomUUID(), conversationId: first.json().conversationId, content: "compare those two images" });
  assert.equal(next.statusCode, 200);
  assert.deepEqual(calls[1].find((message) => message.content === "question").images.map((image) => image.buffer.toString()), attachmentMediaIds);
  const media = await db.select().from(schema.mediaObjects);
  assert.ok(media.every((item) => item.referenceCount === 1));
  mediaReads = [];
  const repeated = await sendText({ requestId: randomUUID(), conversationId: first.json().conversationId, attachmentMediaIds });
  assert.equal(repeated.statusCode, 200);
  assert.equal(mediaReads.length, 2);
  assert.equal(new Set(mediaReads).size, 2);
});

test("concurrent image submissions and retries share the existing user capacity", async () => {
  const [batch] = await db.insert(schema.generationBatches).values({ userId, modelId: imageModelId, prompt: "seed", requestedCount: 1 }).returning();
  await db.insert(schema.generationTasks).values(Array.from({ length: 49 }, (_, sequence) => ({ batchId: batch.id, userId, modelId: imageModelId, sequence, prompt: "seed", priceSnapshot: "1", modelNameSnapshot: "image", modelDisplayNameSnapshot: "Image", status: sequence === 48 ? "failed" : "queued" })));
  const responses = await Promise.all(Array.from({ length: 3 }, () => app.inject({ method: "POST", url: "/api/generation-batches", payload: { modelId: imageModelId, prompt: "image", count: 1 } })));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 202, 429]);
  const tasks = await db.select().from(schema.generationTasks);
  assert.equal(tasks.filter((task) => task.status === "queued").length, 50);
  const failed = tasks.find((task) => task.status === "failed");
  assert.equal((await app.inject({ method: "POST", url: `/api/generation-batches/tasks/${failed.id}/retry` })).statusCode, 429);
  assert.equal((await db.select().from(schema.generationTasks).where(eq(schema.generationTasks.id, failed.id)))[0].status, "failed");
});
