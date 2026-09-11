import { Client } from "minio";
import { config } from "./config.js";

export const minio = new Client({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
});

export async function ensureMediaBucket() {
  if (!(await minio.bucketExists(config.MINIO_BUCKET))) {
    await minio.makeBucket(config.MINIO_BUCKET);
  }
}
