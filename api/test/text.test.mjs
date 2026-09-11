import assert from "node:assert/strict";
import { mock, test } from "node:test";
import Fastify from "fastify";
import * as schema from "../src/db/schema.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const conversationId = "10000000-0000-4000-8000-000000000002";
const requestId = "10000000-0000-4000-8000-000000000003";
const modelId = "10000000-0000-4000-8000-000000000004";
const responseMessage = { id: "10000000-0000-4000-8000-000000000005", conversationId, role: "assistant", content: "saved answer" };
let channelAvailable = true;
let upstreamCalls = 0;
const existing = { id: requestId, userId, conversationId, modelId, status: "succeeded", responseMessageId: responseMessage.id };

const db = {
  select() {
    let table;
    const query = {
      from(value) { table = value; return query; },
      where() { return query; },
      limit() {
        if (table === schema.models) return Promise.resolve([{ id: modelId, name: "text", displayName: "Text" }]);
        if (table === schema.textRequests) return Promise.resolve([existing]);
        if (table === schema.messages) return Promise.resolve([responseMessage]);
        if (table === schema.conversations) return Promise.resolve([{ id: conversationId }]);
        throw new Error("Unexpected query");
      },
    };
    return query;
  },
};

mock.module("../src/db/client.ts", { namedExports: { db } });
mock.module("../src/config.ts", { namedExports: { config: { MAX_UPLOAD_BYTES: 50 * 1024 * 1024 } } });
mock.module("../src/auth/session.ts", { namedExports: { authenticate: async () => ({ id: userId }) } });
mock.module("../src/channel-scheduler.ts", { namedExports: {
  hasChannelCandidates: async () => channelAvailable,
  runWithFailover: async () => { upstreamCalls++; throw new Error("Replay must not call upstream"); },
  UpstreamError: class extends Error {},
} });
mock.module("../src/media.ts", { namedExports: { minio: {} } });
mock.module("../src/request-logs.ts", { namedExports: { startRequestLog() {}, finishRequestLog() {} } });
mock.module("../src/upstream.ts", { namedExports: { generateText() {}, readStreamWithLimit() {} } });
const { textRoutes } = await import("../src/routes/text.ts");

test("successful text replay returns the full response even while the channel is unavailable", async () => {
  const app = Fastify();
  await app.register(textRoutes, { prefix: "/api/text" });
  try {
    for (const available of [true, false]) {
      channelAvailable = available;
      const response = await app.inject({ method: "POST", url: "/api/text/requests", payload: { requestId, conversationId, modelId, content: "question" } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { conversationId, requestId, message: responseMessage });
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    await app.close();
  }
});
