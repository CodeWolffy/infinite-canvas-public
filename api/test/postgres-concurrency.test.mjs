import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { mock, test } from "node:test";
import Fastify from "fastify";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema.ts";

// PGlite serializes transactions; these races need separate PostgreSQL connections.
test("UUID aliases preserve request and canvas consistency", { skip: !process.env.TEST_POSTGRES_URL }, async (t) => {
  const namespace = `uuid_review_${randomUUID().replaceAll("-", "")}`;
  const inspector = postgres(process.env.TEST_POSTGRES_URL, { max: 2, onnotice: () => {} });
  await inspector`create schema ${inspector(namespace)}`;
  const client = postgres(process.env.TEST_POSTGRES_URL, { max: 4, onnotice: () => {}, connection: { application_name: namespace, search_path: namespace } });
  const db = drizzle(client, { schema });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await client.end();
    await inspector`drop schema ${inspector(namespace)} cascade`;
    await inspector.end();
  });
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const { tag } of journal.entries) {
    await client.unsafe(await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8"));
  }

  const userId = randomUUID(), modelId = randomUUID(), imageModelId = randomUUID(), channelId = randomUUID();
  const candidate = { channelId, channelName: "test", upstreamModel: "text-test" };
  let failText = false, calls = 0;
  class UpstreamError extends Error { constructor(message, category) { super(message); this.category = category; } }
  mock.module("../src/db/client.ts", { namedExports: { db } });
  mock.module("../src/auth/session.ts", { namedExports: { authenticate: async () => ({ id: userId, role: "user" }) } });
  mock.module("../src/config.ts", { namedExports: { config: { MAX_UPLOAD_BYTES: 50 * 1024 * 1024, ORPHAN_MEDIA_GRACE_DAYS: 45 } } });
  mock.module("../src/channel-scheduler.ts", { namedExports: {
    hasChannelCandidates: async () => true,
    runWithFailover: async (_modelId, action) => ({ result: await action(candidate), candidate }),
    UpstreamError,
  } });
  mock.module("../src/upstream.ts", { namedExports: {
    generateText: async () => { calls++; if (failText) throw new UpstreamError("test failure", "test_failure"); return "saved answer"; },
    readStreamWithLimit: async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); },
  } });
  mock.module("../src/media.ts", { namedExports: { minio: {
    removeObjects: async () => [],
    getObject: async () => Readable.from([Buffer.from("test")]),
  } } });
  mock.module("../src/generation-worker.ts", { namedExports: { enqueueGenerationTask: async () => {} } });
  const { textRoutes } = await import("../src/routes/text.ts");
  const { canvasProjectRoutes } = await import("../src/routes/canvas-projects.ts");
  const { mediaRoutes } = await import("../src/routes/media.ts");
  const { generationBatchRoutes } = await import("../src/routes/generation-batches.ts");
  await app.register(textRoutes, { prefix: "/api/text" });
  await app.register(canvasProjectRoutes, { prefix: "/api/canvas-projects" });
  await app.register(mediaRoutes, { prefix: "/api/media" });
  await app.register(generationBatchRoutes, { prefix: "/api/generation-batches" });
  await db.insert(schema.users).values({ id: userId, username: "test", displayName: "Test", passwordHash: "test" });
  await db.insert(schema.models).values([
    { id: modelId, name: "text", displayName: "Text", capability: "text", status: "published" },
    { id: imageModelId, name: "image", displayName: "Image", capability: "image", status: "published", pricePerImage: "1" },
  ]);
  await db.insert(schema.channels).values({ id: channelId, name: "test", protocol: "openai", baseUrl: "https://invalid.invalid" });

  async function waitForLocks(count) {
    const signal = AbortSignal.timeout(10000);
    while (true) {
      const [waiting] = await inspector`select count(*)::int as count from pg_stat_activity where application_name = ${namespace} and wait_event_type = 'Lock' and state = 'active'`;
      if (waiting.count === count) return;
      await setTimeout(10, undefined, { signal });
    }
  }

  async function overlapAtRow(table, id, submit) {
    let locked, release;
    const acquired = new Promise((resolve) => { locked = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const lock = inspector.begin(async (tx) => {
      await tx`select id from ${tx(`${namespace}.${table}`)} where id = ${id}::uuid for update`;
      locked();
      await held;
    });
    await Promise.race([acquired, lock]);
    const responses = submit();
    try {
      await waitForLocks(2);
    } finally {
      release();
      await lock;
    }
    return responses;
  }

  await t.test("case variants cannot retry a failed text request twice", async () => {
    const requestId = randomUUID();
    const send = (id, conversationId) => app.inject({ method: "POST", url: "/api/text/requests", payload: { requestId: id, conversationId, modelId, content: "question" } });
    failText = true;
    const initial = await send(requestId);
    assert.equal(initial.statusCode, 502);
    failText = false; calls = 0;
    const conversationId = initial.json().conversationId;
    const responses = await overlapAtRow("text_requests", requestId, () => Promise.all([
      send(requestId, conversationId), send(requestId.toUpperCase(), conversationId),
    ]));
    assert.equal(calls, 1);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    const conversation = await app.inject({ url: `/api/text/conversations/${conversationId}` });
    assert.equal(conversation.json().messages.filter((message) => message.role === "assistant").length, 1);
  });

  await t.test("case variants cannot leave media outside the final canvas snapshot", async () => {
    const mediaIds = [randomUUID(), randomUUID()];
    await db.insert(schema.mediaObjects).values(mediaIds.map((id) => ({ id, ownerId: userId, bucket: "test", objectKey: id, originalName: "test.png", mimeType: "image/png", byteSize: 4, sha256: id })));
    const created = await app.inject({ method: "POST", url: "/api/canvas-projects", payload: { title: "test", snapshot: { nodes: [], connections: [] } } });
    assert.equal(created.statusCode, 201);
    const projectId = created.json().project.id;
    const history = await app.inject({ method: "POST", url: `/api/canvas-projects/${projectId}/history`, payload: {} });
    assert.equal(history.statusCode, 201);
    const responses = await overlapAtRow("canvas_projects", projectId, () => Promise.all(mediaIds.map((mediaId, index) => app.inject({
      method: "PUT", url: `/api/canvas-projects/${index ? projectId.toUpperCase() : projectId}`,
      payload: { snapshot: { nodes: [{ fileId: mediaId }], connections: [] } },
    }))));
    assert.ok(responses.every((response) => response.statusCode === 200));
    const saved = await app.inject({ url: `/api/canvas-projects/${projectId}` });
    const kept = saved.json().project.snapshot.nodes[0].fileId;
    const removed = mediaIds.find((id) => id !== kept);
    assert.equal((await app.inject({ url: `/api/media/${kept}` })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/media/${removed}` })).statusCode, 404);
  });

  await t.test("case variants cannot delete a batch while its failed task is retried", async () => {
    const created = await app.inject({ method: "POST", url: "/api/generation-batches", payload: { modelId: imageModelId, prompt: "image", count: 1 } });
    assert.equal(created.statusCode, 202);
    const { batch, tasks } = created.json();
    const taskId = tasks[0].id;
    await db.update(schema.generationTasks).set({ status: "failed" }).where(eq(schema.generationTasks.id, taskId));
    const responses = await overlapAtRow("generation_tasks", taskId, async () => {
      const retry = app.inject({ method: "POST", url: `/api/generation-batches/tasks/${taskId}/retry` }).then((response) => response);
      await waitForLocks(1);
      return Promise.all([retry, app.inject({ method: "DELETE", url: `/api/generation-batches/${batch.id.toUpperCase()}` })]);
    });
    assert.deepEqual(responses.map((response) => response.statusCode), [202, 409]);
    const current = await app.inject({ url: `/api/generation-batches/${batch.id}` });
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().tasks[0].status, "queued");
  });
});
