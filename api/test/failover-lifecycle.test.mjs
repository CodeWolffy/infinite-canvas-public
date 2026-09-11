import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.ts";
import { createTestDatabase } from "./helpers/database.mjs";

const { client, db } = await createTestDatabase();
const userId = randomUUID(), modelId = randomUUID();
const channelIds = [randomUUID(), randomUUID()];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "base64");
let worker, failAttemptWrite = false, failStorage = false;
let calls = [], outcomes = new Map(), objects = new Map();
const query = client.query.bind(client);
mock.method(client, "query", async (sql, params, ...rest) => {
  if (failAttemptWrite && /^update "generation_attempts"/.test(sql) && params[0] === "failed") {
    if (failAttemptWrite !== "always") failAttemptWrite = false;
    throw new Error("fixture attempt update failed");
  }
  return query(sql, params, ...rest);
});
mock.module("../src/db/client.ts", { namedExports: { db } });
mock.module("../src/config.ts", { namedExports: { config: {
  DATABASE_URL: "postgres://test:test@invalid.invalid/test", CHANNEL_ENCRYPTION_KEY: "worker-lifecycle-test-encryption-key",
  IMAGE_WORKER_CONCURRENCY: 1, MAX_UPLOAD_BYTES: 50 * 1024 * 1024, MINIO_BUCKET: "test-bucket",
} } });
mock.module("pg-boss", { defaultExport: class {
  async start() {}
  async stop() {}
  async getQueue() { return { policy: "standard" }; }
  async createQueue() {}
  async send() {}
  async work(_name, _options, callback) { worker = callback; }
} });
mock.module("../src/upstream.ts", { namedExports: {
  generateImage: async (candidate) => { calls.push(candidate.channelId); const error = outcomes.get(candidate.channelId); if (error) throw error; return png; },
  validateGeneratedImage: async () => ({ mime: "image/png", ext: "png" }),
  readStreamWithLimit: async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); },
} });
mock.module("../src/media.ts", { namedExports: { minio: {
  async putObject(_bucket, key, buffer) { if (failStorage) throw new Error("fixture MinIO write failed"); objects.set(key, buffer); },
  async removeObject(_bucket, key) { objects.delete(key); },
} } });
const { UpstreamError } = await import("../src/channel-scheduler.ts");
const { startGenerationWorker, stopGenerationWorker } = await import("../src/generation-worker.ts");
await startGenerationWorker();
after(async () => { await stopGenerationWorker(); await client.close(); });
beforeEach(async () => {
  await client.exec("truncate users, models, channels cascade");
  await db.insert(schema.users).values({ id: userId, username: "test", displayName: "Test", passwordHash: "test" });
  await db.insert(schema.models).values({ id: modelId, name: "image", displayName: "Image", capability: "image", status: "published", pricePerImage: "1.25" });
  await db.insert(schema.channels).values(channelIds.map((id, index) => ({ id, name: `channel-${index}`, protocol: "openai", baseUrl: "https://invalid.invalid", status: "active" })));
  await db.insert(schema.modelChannels).values(channelIds.map((channelId, index) => ({ modelId, channelId, upstreamModel: "image", priority: 100 - index, weight: 1, enabled: true })));
  calls = []; outcomes = new Map(); objects = new Map(); failAttemptWrite = false; failStorage = false;
});

async function runTask() {
  const [batch] = await db.insert(schema.generationBatches).values({ userId, modelId, prompt: "test", requestedCount: 1 }).returning();
  const [task] = await db.insert(schema.generationTasks).values({ batchId: batch.id, userId, modelId, sequence: 0, prompt: "test", priceSnapshot: "1.25", modelNameSnapshot: "image", modelDisplayNameSnapshot: "Image" }).returning();
  await worker([{ data: { taskId: task.id } }]);
  const [saved] = await db.select().from(schema.generationTasks).where(eq(schema.generationTasks.id, task.id));
  const attempts = await db.select().from(schema.generationAttempts).where(eq(schema.generationAttempts.taskId, task.id));
  const logs = await db.select().from(schema.requestLogs).where(eq(schema.requestLogs.taskId, task.id));
  const images = await db.select().from(schema.generatedImages).where(eq(schema.generatedImages.taskId, task.id));
  return { task: saved, attempts, logs, images };
}

test("a failed attempt write preserves a non-retryable upstream error without another paid call", async () => {
  outcomes.set(channelIds[0], new UpstreamError("fixture safety refusal", "content_policy", 400, "never"));
  failAttemptWrite = true;
  const result = await runTask();
  assert.deepEqual(calls, [channelIds[0]]);
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.errorCode, "content_policy");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, "failed");
  assert.equal(result.attempts[0].errorCategory, "content_policy");
  assert.equal(result.logs[0].status, "failed");
  assert.equal(result.logs[0].errorCategory, "content_policy");
  assert.equal(result.images.length, 0);
  assert.equal(objects.size, 0);
});

for (const failedWrite of [false, true]) {
  test(`fallback stores one paid result and closes both attempts${failedWrite ? " after a failed attempt write" : ""}`, async () => {
    outcomes.set(channelIds[0], new UpstreamError("fixture unavailable", "http_503", 503, "always"));
    failAttemptWrite = failedWrite;
    const result = await runTask();
    assert.deepEqual(calls, channelIds);
    assert.equal(result.task.status, "succeeded");
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts.find((attempt) => attempt.channelId === channelIds[0]).status, "failed");
    assert.equal(result.attempts.find((attempt) => attempt.channelId === channelIds[1]).status, "succeeded");
    assert.ok(result.attempts.every((attempt) => attempt.finishedAt));
    assert.equal(result.logs.length, 2);
    assert.equal(result.logs.find((log) => log.channelId === channelIds[0]).status, "failed");
    const successfulLog = result.logs.find((log) => log.channelId === channelIds[1]);
    assert.equal(successfulLog.status, "succeeded");
    assert.equal(Number(successfulLog.billedAmount), 1.25);
    assert.ok(result.logs.every((log) => log.finishedAt));
    assert.equal(result.images.length, 1);
    assert.equal(Number(result.images[0].billedAmount), 1.25);
    assert.equal((await db.select().from(schema.mediaObjects)).length, 1);
    assert.equal(objects.size, 1);
  });
}

function assertUnbilledFailure(result, errorCode) {
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.errorCode, errorCode);
  assert.equal(result.attempts.length, calls.length);
  assert.equal(result.logs.length, calls.length);
  assert.ok(result.attempts.every((attempt) => attempt.status === "failed" && attempt.finishedAt));
  assert.ok(result.logs.every((log) => log.status === "failed" && log.finishedAt && !Number(log.billedAmount)));
  assert.equal(result.images.length, 0);
  assert.equal(objects.size, 0);
}

test("exhausted fallback preserves the final upstream failure and leaves no running records", async () => {
  outcomes.set(channelIds[0], new UpstreamError("fixture unavailable", "http_503", 503, "always"));
  outcomes.set(channelIds[1], new UpstreamError("fixture invalid credential", "http_401", 401, "always"));
  const result = await runTask();
  assert.deepEqual(calls, channelIds);
  assertUnbilledFailure(result, "http_401");
  assert.deepEqual(result.attempts.map((attempt) => attempt.errorCategory).sort(), ["http_401", "http_503"]);
});

test("MinIO failure after upstream success does not generate again or leave a running attempt", async () => {
  failStorage = true;
  const result = await runTask();
  assert.deepEqual(calls, [channelIds[0]]);
  assertUnbilledFailure(result, "internal_error");
  assert.equal((await db.select().from(schema.mediaObjects)).length, 0);
});

test("metadata failure after upstream success rolls back billing and removes the stored object", async () => {
  await client.exec(`
    create function worker_lifecycle_reject_media() returns trigger language plpgsql as $$
    begin raise exception 'fixture media metadata failure'; end $$;
    create trigger worker_lifecycle_reject_media before insert on media_objects
    for each row execute function worker_lifecycle_reject_media();
  `);
  try {
    const result = await runTask();
    assert.deepEqual(calls, [channelIds[0]]);
    assertUnbilledFailure(result, "internal_error");
    assert.equal((await db.select().from(schema.mediaObjects)).length, 0);
  } finally {
    await client.exec("drop trigger worker_lifecycle_reject_media on media_objects; drop function worker_lifecycle_reject_media()");
  }
});

test("persistent attempt bookkeeping failure still preserves the original non-retryable result", async () => {
  outcomes.set(channelIds[0], new UpstreamError("fixture safety refusal", "content_policy", 400, "never"));
  failAttemptWrite = "always";
  const warning = mock.method(console, "warn", () => {});
  try {
    const result = await runTask();
    assert.deepEqual(calls, [channelIds[0]]);
    assert.equal(result.task.status, "failed");
    assert.equal(result.task.errorCode, "content_policy");
    assert.equal(result.logs[0].status, "failed");
    assert.equal(result.logs[0].errorCategory, "content_policy");
    assert.equal(result.images.length, 0);
    assert.equal(objects.size, 0);
    assert.ok(warning.mock.callCount() > 0);
  } finally {
    warning.mock.restore();
  }
});
