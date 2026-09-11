import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";
import { appSettings, models, userPreferences } from "../db/schema.js";

const preferencesBody = z.record(z.string(), z.unknown());

const changelogEntry = z.object({
  date: z.string().trim().max(40).default(""),
  tag: z.string().trim().max(20).default(""),
  title: z.string().trim().max(120).default(""),
  body: z.string().trim().max(1000).default(""),
});

const announcementBody = z.object({
  title: z.string().trim().max(80).default(""),
  content: z.string().trim().max(8000).default(""),
  entries: z.array(changelogEntry).max(30).default([]),
  forceAlert: z.boolean().optional(),
});

const announcementKey = "announcement";
export type ChangelogEntry = z.infer<typeof changelogEntry>;
export type Announcement = z.infer<typeof announcementBody> & { publishedAt: string };

const emptyAnnouncement: Announcement = { title: "", content: "", entries: [], publishedAt: "" };

/**
 * Older deployments stored a bare { content: string }; anything missing falls back to defaults so
 * the endpoint keeps working without a migration.
 */
async function readAnnouncement(): Promise<Announcement> {
  const [row] = await db
    .select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .where(eq(appSettings.key, announcementKey))
    .limit(1);
  if (!row) return emptyAnnouncement;
  const value = (row.value ?? {}) as Record<string, unknown>;
  const parsed = announcementBody.safeParse(value);
  const base = parsed.success ? parsed.data : { ...emptyAnnouncement, content: typeof value.content === "string" ? value.content : "" };
  const publishedAt = typeof value.publishedAt === "string" && value.publishedAt
    ? value.publishedAt
    : (row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date().toISOString());
  return { ...base, publishedAt };
}

export async function modelRoutes(app: FastifyInstance) {
  app.get("/", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const result = await db
      .select({
        id: models.id,
        name: models.name,
        displayName: models.displayName,
        capability: models.capability,
        sortOrder: models.sortOrder,
        description: models.description,
      })
      .from(models)
      .where(and(eq(models.status, "published"), isNull(models.deletedAt)))
      .orderBy(asc(models.sortOrder), asc(models.displayName));
    return { models: result };
  });
}

export async function preferenceRoutes(app: FastifyInstance) {
  app.get("/announcement", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    return { announcement: await readAnnouncement() };
  });

  app.put("/admin/announcement", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const body = announcementBody.parse(request.body);
    const { forceAlert, ...data } = body;
    const previous = await readAnnouncement();
    const changed = previous.title !== data.title || previous.content !== data.content || JSON.stringify(previous.entries) !== JSON.stringify(data.entries);
    // Bump publishedAt on a real edit, explicit forceAlert, or when publishedAt is missing.
    const publishedAt = changed || forceAlert || !previous.publishedAt ? new Date().toISOString() : previous.publishedAt;
    const value = { ...data, publishedAt };
    await db
      .insert(appSettings)
      .values({ key: announcementKey, value })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: new Date() },
      });
    return { announcement: value };
  });

  app.get("/preferences", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const [result] = await db
      .select({ preferences: userPreferences.preferences })
      .from(userPreferences)
      .where(eq(userPreferences.userId, user.id))
      .limit(1);
    return { preferences: result?.preferences ?? {} };
  });

  app.put("/preferences", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const preferences = preferencesBody.parse(request.body);
    await db
      .insert(userPreferences)
      .values({ userId: user.id, preferences })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { preferences, updatedAt: new Date() },
      });
    return { preferences };
  });
}
