import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "../auth/password.js";
import { authenticate, publicUser, revokeUserSessions } from "../auth/session.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

const createUserBody = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,64}$/),
  displayName: z.string().trim().min(1).max(80),
  temporaryPassword: z.string().min(10).max(128),
  role: z.enum(["admin", "user"]).default("user"),
});

const statusBody = z.object({ status: z.enum(["active", "disabled"]) });
const roleBody = z.object({ role: z.enum(["admin", "user"]) });
const resetPasswordBody = z.object({ temporaryPassword: z.string().min(10).max(128) });
const userParams = z.object({ id: z.string().uuid() });

export async function adminUserRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return reply;
  });

  app.get("/", async (_request, _reply) => {
    const result = await db.select().from(users).orderBy(desc(users.createdAt));
    return { users: result.map(publicUser) };
  });

  app.post("/", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const body = createUserBody.parse(request.body);
    const username = body.username.toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) {
      return reply.code(409).send({ error: "username_exists", message: "用户名已存在" });
    }

    const [user] = await db
      .insert(users)
      .values({
        username,
        passwordHash: await hashPassword(body.temporaryPassword),
        displayName: body.displayName,
        role: body.role,
        mustChangePassword: true,
      })
      .returning();
    return reply.code(201).send({ user: publicUser(user!) });
  });

  app.patch("/:id/status", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = userParams.parse(request.params);
    const body = statusBody.parse(request.body);
    if (id === admin.id && body.status === "disabled") {
      return reply.code(400).send({ error: "cannot_disable_self", message: "不能禁用当前账号" });
    }
    const [user] = await db
      .update(users)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!user) return reply.code(404).send({ error: "not_found", message: "用户不存在" });
    if (body.status === "disabled") await revokeUserSessions(id);
    return { user: publicUser(user) };
  });

  app.patch("/:id/role", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = userParams.parse(request.params);
    const body = roleBody.parse(request.body);
    if (id === admin.id && body.role !== "admin") {
      return reply.code(400).send({ error: "cannot_demote_self", message: "不能降级当前账号" });
    }
    const [user] = await db
      .update(users)
      .set({ role: body.role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!user) return reply.code(404).send({ error: "not_found", message: "用户不存在" });
    return { user: publicUser(user) };
  });

  app.post("/:id/reset-password", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return;
    const { id } = userParams.parse(request.params);
    const body = resetPasswordBody.parse(request.body);
    const [user] = await db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.temporaryPassword),
        mustChangePassword: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    if (!user) return reply.code(404).send({ error: "not_found", message: "用户不存在" });
    await revokeUserSessions(id);
    return { user: publicUser(user) };
  });
}
