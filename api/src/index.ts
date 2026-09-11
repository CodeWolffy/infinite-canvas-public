import { buildApp } from "./app.js";
import { bootstrapAdmin, recoverInterruptedTextRequests } from "./bootstrap.js";
import { cleanupExpiredSessions } from "./auth/session.js";
import { config } from "./config.js";
import { closeDatabase, migrateDatabase } from "./db/client.js";
import { ensureMediaBucket } from "./media.js";
import { startOrphanCleanup, stopOrphanCleanup } from "./media-cleanup.js";
import { startGenerationWorker, stopGenerationWorker } from "./generation-worker.js";
import { cleanupOldRequestLogs } from "./request-logs.js";

await migrateDatabase();
await ensureMediaBucket();
await recoverInterruptedTextRequests();
await bootstrapAdmin();
await startGenerationWorker();
const orphanTimer = startOrphanCleanup((error, mediaId) => console.error("[media-cleanup]", mediaId, error));
const cleanRequestLogs = () => void cleanupOldRequestLogs().catch((error) => console.error("[request-logs]", error));
cleanRequestLogs();
const requestLogTimer = setInterval(cleanRequestLogs, 24 * 60 * 60 * 1000);
const cleanSessions = () => void cleanupExpiredSessions().catch((error) => console.error("[sessions]", error));
cleanSessions();
const sessionTimer = setInterval(cleanSessions, 24 * 60 * 60 * 1000);

const app = buildApp();
const close = async () => {
  stopOrphanCleanup(orphanTimer);
  clearInterval(requestLogTimer);
  clearInterval(sessionTimer);
  await app.close();
  await stopGenerationWorker();
  await closeDatabase();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ host: config.HOST, port: config.PORT });
