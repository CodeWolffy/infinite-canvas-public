import { and, eq, inArray } from "drizzle-orm";
import { hashPassword } from "./auth/password.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { requestLogs, textRequests, users } from "./db/schema.js";

export async function recoverInterruptedTextRequests() {
  const finishedAt = new Date();
  const recovered = await db
    .update(textRequests)
    .set({ status: "failed", errorCode: "service_restart", finishedAt })
    .where(eq(textRequests.status, "running"))
    .returning({ id: textRequests.id });

  if (recovered.length) {
    await db
      .update(requestLogs)
      .set({
        status: "failed",
        errorCategory: "service_restart",
        errorMessage: "服务重启，中断的文本请求已结束",
        finishedAt,
      })
      .where(
        and(
          inArray(requestLogs.textRequestId, recovered.map((r) => r.id)),
          eq(requestLogs.status, "running"),
        ),
      );
  }
}

export async function bootstrapAdmin() {
  if (!config.BOOTSTRAP_ADMIN_USERNAME || !config.BOOTSTRAP_ADMIN_PASSWORD) return;

  const username = config.BOOTSTRAP_ADMIN_USERNAME.trim().toLowerCase();
  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existing?.role === "admin") return;
  if (existing) throw new Error("初始化管理员用户名已被普通用户占用");

  await db.insert(users).values({
    username,
    passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
    displayName: config.BOOTSTRAP_ADMIN_DISPLAY_NAME,
    role: "admin",
    mustChangePassword: true,
  });
}
