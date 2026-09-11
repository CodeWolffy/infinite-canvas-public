import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { after, beforeEach, mock, test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.ts";
import { createTestDatabase } from "./helpers/database.mjs";

const { client, db } = await createTestDatabase();
const userId = "10000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000002";
let currentUser = userId;
let deletionFailure;
const removedKeys = [];
const cleanupErrors = [];

mock.module("../src/db/client.ts", { namedExports: { db } });
mock.module("../src/auth/session.ts", { namedExports: { authenticate: async () => ({ id: currentUser, role: "user" }) } });
mock.module("../src/config.ts", { namedExports: { config: { ORPHAN_MEDIA_GRACE_DAYS: 45 } } });
mock.module("../src/media.ts", { namedExports: { minio: {
  async removeObjects(_bucket, keys) {
    if (deletionFailure === "network") throw new Error("MinIO unavailable");
    if (deletionFailure === "partial") return [{ Key: keys[0], Code: "AccessDenied" }];
    removedKeys.push(...keys);
    return [];
  },
  async getObject() { return Readable.from([Buffer.from("test")]); },
} } });

const { canvasProjectRoutes } = await import("../src/routes/canvas-projects.ts");
const { mediaRoutes } = await import("../src/routes/media.ts");
const { removeUnreferencedMedia, cleanupOrphanMedia } = await import("../src/media-cleanup.ts");
const { extractMediaIds } = await import("../src/media-references.ts");
const app = Fastify();
await app.register(canvasProjectRoutes, { prefix: "/api/canvas-projects" });
await app.register(mediaRoutes, { prefix: "/api/media" });

beforeEach(async () => {
  await client.exec("truncate users cascade");
  await db.insert(schema.users).values([userId, ownerId].map((id) => ({ id, username: id, displayName: id, passwordHash: "test" })));
  currentUser = userId;
  deletionFailure = undefined;
  removedKeys.length = 0;
  cleanupErrors.length = 0;
});

after(async () => {
  await app.close();
  await client.close();
});

async function createMedia(owner = userId) {
  const id = randomUUID();
  const [media] = await db.insert(schema.mediaObjects).values({ id, ownerId: owner, bucket: "test-bucket", objectKey: id, originalName: "test.png", mimeType: "image/png", byteSize: 4, sha256: id }).returning();
  return media;
}

function snapshot(mediaId) {
  return { nodes: mediaId ? [{ id: "image", type: "image", fileId: mediaId }] : [], connections: [] };
}

async function createProject(mediaId) {
  const response = await app.inject({ method: "POST", url: "/api/canvas-projects", payload: { title: "test", snapshot: snapshot(mediaId) } });
  assert.equal(response.statusCode, 201);
  return response.json().project;
}

async function saveHistory(projectId) {
  const response = await app.inject({ method: "POST", url: `/api/canvas-projects/${projectId}/history`, payload: {} });
  assert.equal(response.statusCode, 201);
  return response.json().history;
}

async function saveProject(projectId, mediaId) {
  return app.inject({ method: "PUT", url: `/api/canvas-projects/${projectId}`, payload: { snapshot: snapshot(mediaId) } });
}

test("removing a current image preserves the file held by a restorable history", async () => {
  const media = await createMedia();
  const project = await createProject(media.id);
  const history = await saveHistory(project.id);
  assert.equal((await saveProject(project.id)).statusCode, 200);
  assert.equal((await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id))).length, 1);
  assert.equal(removedKeys.length, 0);
  const restored = await app.inject({ method: "POST", url: `/api/canvas-projects/${project.id}/history/${history.id}/restore` });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().project.snapshot.nodes[0].fileId, media.id);
});

test("an existing canvas remains saveable after its public source asset is withdrawn", async () => {
  const media = await createMedia(ownerId);
  await db.insert(schema.assets).values({ ownerId, scope: "public", type: "image", title: "public", mediaId: media.id });
  const project = await createProject(media.id);
  await db.delete(schema.assets).where(eq(schema.assets.mediaId, media.id));
  assert.equal((await saveProject(project.id, media.id)).statusCode, 200);
  const copied = await createProject(media.id);
  assert.notEqual(copied.id, project.id);
});

test("a private media ID in a new snapshot does not grant access", async () => {
  const media = await createMedia(ownerId);
  const response = await app.inject({ method: "POST", url: "/api/canvas-projects", payload: { title: "private", snapshot: snapshot(media.id) } });
  assert.equal(response.statusCode, 400);
  assert.equal((await app.inject({ url: `/api/media/${media.id}` })).statusCode, 403);
});

test("private image caches revalidate permissions before returning 304", async () => {
  const media = await createMedia();
  const initial = await app.inject({ url: `/api/media/${media.id}` });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers["cache-control"], "private, no-cache");
  const headers = { "if-none-match": initial.headers.etag };
  const unchanged = await app.inject({ url: `/api/media/${media.id}`, headers });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.headers["cache-control"], "private, no-cache");
  assert.equal(unchanged.headers.etag, initial.headers.etag);
  currentUser = ownerId;
  assert.equal((await app.inject({ url: `/api/media/${media.id}`, headers })).statusCode, 403);
});

test("historical references retain withdrawn public media access and prevent cleanup", async () => {
  const media = await createMedia(ownerId);
  await db.insert(schema.assets).values({ ownerId, scope: "public", type: "image", title: "public", mediaId: media.id });
  const project = await createProject(media.id);
  await saveHistory(project.id);
  await db.delete(schema.assets).where(eq(schema.assets.mediaId, media.id));
  assert.equal((await saveProject(project.id)).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/media/${media.id}` })).statusCode, 200);
  await db.update(schema.mediaObjects).set({ referenceCount: 0, status: "deleting" }).where(eq(schema.mediaObjects.id, media.id));
  await cleanupOrphanMedia((error) => cleanupErrors.push(error));
  const [retained] = await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id));
  assert.equal(retained.status, "ready");
  assert.equal(removedKeys.length, 0);
  await createProject(media.id);
});

test("restoring the oldest of twenty histories claims its media before trimming", async () => {
  const media = await createMedia();
  const project = await createProject(media.id);
  const history = await saveHistory(project.id);
  assert.equal((await saveProject(project.id)).statusCode, 200);
  for (let index = 0; index < 19; index += 1) await saveHistory(project.id);
  const response = await app.inject({ method: "POST", url: `/api/canvas-projects/${project.id}/history/${history.id}/restore` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().project.snapshot.nodes[0].fileId, media.id);
  assert.equal((await db.select().from(schema.canvasProjectHistory).where(eq(schema.canvasProjectHistory.projectId, project.id))).length, 20);
  const [retained] = await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id));
  assert.equal(retained.referenceCount, 1);
  assert.equal(removedKeys.length, 0);
});

test("trimming the final history releases its media", async () => {
  const media = await createMedia();
  const project = await createProject(media.id);
  await saveHistory(project.id);
  assert.equal((await saveProject(project.id)).statusCode, 200);
  for (let index = 0; index < 20; index += 1) await saveHistory(project.id);
  assert.equal((await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id))).length, 0);
  assert.deepEqual(removedKeys, [media.objectKey]);
});

test("deleting a project also releases all of its historical media references", async () => {
  const media = await createMedia();
  const project = await createProject(media.id);
  await saveHistory(project.id);
  assert.equal((await saveProject(project.id)).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/canvas-projects/${project.id}` })).statusCode, 204);
  assert.equal((await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id))).length, 0);
  assert.deepEqual(removedKeys, [media.objectKey]);
});

test("failed MinIO cleanup retains metadata and retries without the orphan grace period", async () => {
  const media = await createMedia();
  deletionFailure = "network";
  await removeUnreferencedMedia([media.id], (error) => cleanupErrors.push(error));
  const [retained] = await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id));
  assert.equal(retained?.status, "deleting");
  assert.equal(cleanupErrors.length, 1);
  deletionFailure = undefined;
  await cleanupOrphanMedia((error) => cleanupErrors.push(error));
  assert.equal((await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id))).length, 0);
  assert.deepEqual(removedKeys, [media.objectKey]);
});

test("partial MinIO deletion failures also retain retryable metadata", async () => {
  const media = await createMedia();
  deletionFailure = "partial";
  await removeUnreferencedMedia([media.id], (error) => cleanupErrors.push(error));
  const [retained] = await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id));
  assert.equal(retained?.status, "deleting");
  assert.equal(cleanupErrors.length, 1);
});

test("existing history backfill follows reference extraction without changing snapshots", async () => {
  const ids = Array.from({ length: 10 }, () => randomUUID());
  const existingSnapshot = {
    nodes: [
      { mediaId: ids[0], fileId: ids[1].toUpperCase(), storageKey: `image:${ids[2]}` },
      { mediaIds: [ids[3], [ids[8]]], fileIds: [ids[4]] },
      { content: `![reference](/api/media/${ids[5]}?download=1)` },
      { mediaId: [[ids[6]]], storageKey: ids[7] },
      { id: ids[8], content: ids[8] },
      { fileId: ids[9] },
    ],
  };
  const expected = [...new Set(extractMediaIds(existingSnapshot).map((id) => id.toLowerCase()))].filter((id) => id !== ids[9]).sort();
  assert.equal(expected.includes(ids[8]), false);
  const isolated = await createTestDatabase({
    async beforeMigration(database, tag) {
      if (tag !== "0010_canvas_history_media") return;
      await database.query("insert into users (id, username, password_hash, display_name) values ($1, 'test', 'test', 'test')", [userId]);
      await database.query("insert into canvas_projects (id, user_id, title, snapshot) values ($1, $2, 'test', '{}'::jsonb)", [ownerId, userId]);
      await database.query("insert into canvas_project_history (id, project_id, user_id, title, snapshot) values ($1, $2, $3, 'test', $4)", [ids[8], ownerId, userId, JSON.stringify(existingSnapshot)]);
      for (const id of ids.slice(0, 9)) {
        await database.query("insert into media_objects (id, owner_id, bucket, object_key, original_name, mime_type, byte_size, sha256, reference_count) values ($1, $2, 'test-bucket', $3, 'test.png', 'image/png', 4, 'test', 3)", [id, userId, id]);
      }
    },
  });
  try {
    const references = await isolated.client.query("select media_id from canvas_project_history_media order by media_id");
    assert.deepEqual(references.rows.map((row) => row.media_id), expected);
    const histories = await isolated.client.query("select snapshot from canvas_project_history");
    assert.deepEqual(histories.rows[0].snapshot, existingSnapshot);
    const counts = await isolated.client.query("select id, reference_count from media_objects");
    assert.equal(counts.rows.every((row) => row.reference_count === (expected.includes(row.id) ? 4 : 3)), true);
  } finally {
    await isolated.client.close();
  }
});
