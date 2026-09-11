import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { sessions, users, type User } from "../db/schema.js";

const sessionMilliseconds = config.SESSION_DAYS * 24 * 60 * 60 * 1000;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(config.COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.COOKIE_SECURE,
    maxAge: Math.floor(sessionMilliseconds / 1000),
  });
}

export async function createSession(userId: string, reply: FastifyReply) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    userId,
    tokenHash: tokenHash(token),
    expiresAt: new Date(Date.now() + sessionMilliseconds),
  });
  setSessionCookie(reply, token);
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(config.COOKIE_NAME, { path: "/" });
}

export async function revokeRequestSession(request: FastifyRequest) {
  const token = request.cookies[config.COOKIE_NAME];
  if (!token) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash(token)), isNull(sessions.revokedAt)));
}

export async function revokeUserSessions(userId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** 已过期的会话在 authenticate 里已经必然被拒绝，直接物理删除，避免表无限增长。 */
export async function cleanupExpiredSessions() {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return result.count ?? 0;
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { admin?: boolean; allowPasswordChange?: boolean } = {},
) {
  const token = request.cookies[config.COOKIE_NAME];
  if (!token) {
    reply.code(401).send({ error: "unauthorized", message: "请先登录" });
    return null;
  }

  const [result] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(users.status, "active"),
      ),
    )
    .limit(1);

  if (!result) {
    clearSessionCookie(reply);
    reply.code(401).send({ error: "unauthorized", message: "登录已失效" });
    return null;
  }
  if (result.user.mustChangePassword && !options.allowPasswordChange) {
    reply.code(403).send({ error: "password_change_required", message: "请先修改初始密码" });
    return null;
  }
  if (options.admin && result.user.role !== "admin") {
    reply.code(403).send({ error: "forbidden", message: "需要管理员权限" });
    return null;
  }
  return result.user;
}
