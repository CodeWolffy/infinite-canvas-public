import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { createTestDatabase } from "./helpers/database.mjs";
import { users } from "../src/db/schema.ts";

Object.assign(process.env, {
  NODE_ENV: "production", DATABASE_URL: "postgres://test:test@invalid.invalid/test",
  CHANNEL_ENCRYPTION_KEY: "public-boundaries-test-encryption-key",
  MINIO_ENDPOINT: "invalid.invalid", MINIO_ACCESS_KEY: "test-access", MINIO_SECRET_KEY: "test-secret",
  CORS_ORIGIN: "https://canvas.example.test",
  TRUST_PROXY: "true",
});
delete process.env.COOKIE_SECURE;
const { client, db } = await createTestDatabase();
let passwordChecks = 0, paused, reachedLimit;
mock.module("../src/db/client.ts", { namedExports: { db } });
mock.module("../src/auth/password.ts", { namedExports: {
  DUMMY_PASSWORD_HASH: "test-only",
  hashPassword: async () => "test-only",
  verifyPassword: async (_hash, password) => {
    passwordChecks++;
    if (passwordChecks === 5) reachedLimit?.();
    await paused;
    return password === "test-correct";
  },
} });
mock.module("../src/media.ts", { namedExports: { minio: {} } });
mock.module("../src/generation-worker.ts", { namedExports: { enqueueGenerationTask: async () => {} } });
const { buildApp } = await import("../src/app.ts");
const app = buildApp();
app.log.level = "silent";
await app.ready();
await db.insert(users).values({ username: "test", displayName: "Test", passwordHash: "test-only", mustChangePassword: false });
after(async () => { await app.close(); await client.close(); });

test("production sessions are secure and browser mutations validate their origin", async () => {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "canvas.example.test", origin: "https://canvas.example.test" }, payload: { username: "test", password: "test-correct" } });
  assert.equal(login.statusCode, 200);
  assert.match(login.headers["set-cookie"], /; HttpOnly/);
  assert.match(login.headers["set-cookie"], /; Secure/);
  for (const origin of ["https://untrusted.example.test", "null"]) {
    const response = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { host: "canvas.example.test", origin } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, "invalid_origin");
  }
  const response = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { host: "canvas.example.test", origin: "https://canvas.example.test" } });
  assert.equal(response.statusCode, 204);
});

test("a concurrent login burst with forged forwarding headers cannot bypass the existing window", async () => {
  passwordChecks = 0;
  let release;
  paused = new Promise((resolve) => { release = resolve; });
  const limited = new Promise((resolve) => { reachedLimit = resolve; });
  const responses = Promise.all(Array.from({ length: 20 }, (_, index) => app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "172.20.0.2", headers: { "x-forwarded-for": `198.51.100.${index + 1}, 203.0.113.12, 172.20.0.1` }, payload: { username: "test", password: "wrong" } })));
  await limited;
  release();
  const results = await responses;
  assert.equal(passwordChecks, 5);
  assert.equal(results.filter((response) => response.statusCode === 401).length, 5);
  assert.equal(results.filter((response) => response.statusCode === 429).length, 15);
});
