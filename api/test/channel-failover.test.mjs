import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { channels, modelChannels, models } from "../src/db/schema.ts";
import { createTestDatabase } from "./helpers/database.mjs";

const { client, db } = await createTestDatabase();
mock.module("../src/db/client.ts", { namedExports: { db } });
mock.module("../src/config.ts", { namedExports: { config: {
  CHANNEL_ENCRYPTION_KEY: "channel-failover-regression-test-key",
  MAX_GENERATED_BYTES: 50 * 1024 * 1024,
  ALLOW_PRIVATE_IMAGE_HOSTS: false,
} } });
const { getChannelCandidates, hasChannelCandidates, runWithFailover, withChannelSlot, UpstreamError } = await import("../src/channel-scheduler.ts");
const { generateText } = await import("../src/upstream.ts");
const { encryptSecret } = await import("../src/crypto.ts");
const modelId = randomUUID();
const channelIds = [randomUUID(), randomUUID(), randomUUID()];
const names = ["primary", "backup", "last"];
const readChannel = async (id = channelIds[0]) => (await db.select().from(channels).where(eq(channels.id, id)))[0];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(async () => {
  await client.exec("truncate models, channels cascade");
  await db.insert(models).values({ id: modelId, name: "test-model", displayName: "Test", capability: "text", status: "published" });
  await db.insert(channels).values(channelIds.map((id, index) => ({
    id, name: names[index], protocol: "openai", baseUrl: `https://${names[index]}.example.invalid/v1`,
    encryptedApiKey: encryptSecret("synthetic-regression-key"), status: "active", maxConcurrency: 1, timeoutMs: 60000, cooldownSeconds: 120,
  })));
  await db.insert(modelChannels).values(channelIds.map((channelId, index) => ({ modelId, channelId, upstreamModel: "text-test", priority: 30 - index * 10, weight: 100, enabled: true })));
});
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
after(async () => { await client.close(); });

function interceptHealthWrites(beforeWrite) {
  const query = client.query.bind(client);
  mock.method(client, "query", async (statement, params, ...options) => {
    if (typeof statement === "string" && statement.startsWith('update "channels"')) await beforeWrite(statement, params);
    return query(statement, params, ...options);
  });
}

test("retryable HTTP failures move through priority order and persist channel cooldowns", async () => {
  const calls = [];
  mock.method(globalThis, "fetch", async (url) => {
    const name = new URL(url).hostname.split(".")[0];
    calls.push(name);
    const status = name === "primary" ? 503 : name === "backup" ? 429 : 200;
    return new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content: "final answer" } }] } : { error: { message: "temporary service failure" } }), { status });
  });
  const result = await runWithFailover(modelId, (candidate) => generateText(candidate, [{ role: "user", content: "test" }], {}));
  assert.deepEqual(calls, names);
  assert.equal(result.candidate.channelId, channelIds[2]);
  assert.equal(result.result, "final answer");
  for (const id of channelIds.slice(0, 2)) assert.ok((await readChannel(id)).cooldownUntil > new Date());
});

test("network and timeout failures reach an available lower-priority channel", async () => {
  const calls = [];
  mock.method(globalThis, "fetch", async (url) => {
    const name = new URL(url).hostname.split(".")[0];
    calls.push(name);
    if (name === "primary") throw new TypeError("synthetic network failure");
    if (name === "backup") throw new DOMException("synthetic timeout", "AbortError");
    return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }));
  });
  const result = await runWithFailover(modelId, (candidate) => generateText(candidate, [{ role: "user", content: "test" }], {}));
  assert.deepEqual(calls, names);
  assert.equal(result.result, "answer");
  assert.equal((await readChannel(channelIds[0])).lastErrorCode, "network");
  assert.equal((await readChannel(channelIds[1])).lastErrorCode, "timeout");
});

test("candidate filtering and weights preserve priority groups", async () => {
  await db.update(modelChannels).set({ priority: 30, weight: 1 }).where(eq(modelChannels.channelId, channelIds[0]));
  await db.update(modelChannels).set({ priority: 30, weight: 100 }).where(eq(modelChannels.channelId, channelIds[1]));
  mock.method(Math, "random", () => 0.5);
  assert.deepEqual((await getChannelCandidates(modelId)).map((item) => item.channelId), [channelIds[1], channelIds[0], channelIds[2]]);
  await db.update(channels).set({ cooldownUntil: new Date(Date.now() + 60000) }).where(eq(channels.id, channelIds[1]));
  await db.update(modelChannels).set({ enabled: false }).where(eq(modelChannels.channelId, channelIds[0]));
  assert.deepEqual((await getChannelCandidates(modelId)).map((item) => item.channelId), [channelIds[2]]);
  await db.update(channels).set({ status: "disabled" }).where(eq(channels.id, channelIds[2]));
  assert.equal(await hasChannelCandidates(modelId), false);
  await assert.rejects(runWithFailover(modelId, async () => assert.fail("no channel may be called")), (error) => error.category === "no_channel");
});

test("ambiguous failures permit only one additional channel", async () => {
  const calls = [];
  await assert.rejects(runWithFailover(modelId, async (candidate) => {
    calls.push(candidate.channelId);
    throw new UpstreamError("test", calls.length === 1 ? "invalid_response" : "http_503", 503, calls.length === 1 ? "once" : "always");
  }));
  assert.deepEqual(calls, channelIds.slice(0, 2));
});

for (const [category, status] of [["invalid_request", 400], ["content_policy", 403]]) {
  test(`${category} stops failover without cooling a healthy channel`, async () => {
    const calls = [];
    const failure = new UpstreamError("request rejected", category, status, "never");
    await assert.rejects(runWithFailover(modelId, async (candidate) => { calls.push(candidate.channelId); throw failure; }), (error) => error === failure);
    assert.deepEqual(calls, [channelIds[0]]);
    assert.equal((await readChannel()).cooldownUntil, null);
  });
}

test("channel slots cap concurrency and are released after errors", async () => {
  const [candidate] = await getChannelCandidates(modelId);
  candidate.maxConcurrency = 2;
  let running = 0, highest = 0;
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => withChannelSlot(candidate, async () => {
    running++; highest = Math.max(highest, running);
    try { await new Promise(setImmediate); if (index % 2) throw new Error("test"); return index; }
    finally { running--; }
  })));
  assert.equal(highest, 2);
  assert.equal(running, 0);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 4);
  assert.equal(await withChannelSlot(candidate, async () => "released"), "released");
});

test("the existing slot wait budget falls back and removes its expired waiter", async () => {
  await db.update(channels).set({ timeoutMs: 2000 }).where(eq(channels.id, channelIds[0]));
  const [candidate] = await getChannelCandidates(modelId);
  const held = deferred(), entered = deferred();
  const holding = withChannelSlot(candidate, async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  const calls = [];
  try {
    const result = await runWithFailover(modelId, async (item) => { calls.push(item.channelId); return "backup answer"; });
    assert.equal(result.result, "backup answer");
    assert.deepEqual(calls, [channelIds[1]]);
    assert.equal((await readChannel()).lastErrorCode, "channel_busy");
  } finally { held.resolve(); await holding; }
  assert.equal(await withChannelSlot(candidate, async () => "free slot"), "free slot");
});

test("auth cooldown preserves the five-minute minimum and a longer configured duration", async () => {
  for (const [cooldownSeconds, expectedMs] of [[0, 300000], [120, 300000], [600, 600000]]) {
    await db.update(channels).set({ cooldownSeconds, cooldownUntil: null }).where(eq(channels.id, channelIds[0]));
    await runWithFailover(modelId, async (candidate) => {
      if (candidate.channelId === channelIds[0]) throw new UpstreamError("credential rejected", "http_401", 401, "always");
      return "backup";
    });
    const primary = await readChannel();
    assert.equal(primary.cooldownUntil.getTime() - primary.lastFailureAt.getTime(), expectedMs);
  }
});

for (const change of ["disabled", "cooling", "unbound"]) {
  test(`a queued request skips a channel that became ${change}`, async () => {
    const [candidate] = await getChannelCandidates(modelId);
    const held = deferred(), entered = deferred();
    const holding = withChannelSlot(candidate, async () => { entered.resolve(); await held.promise; });
    await entered.promise;
    const calls = [];
    const pending = runWithFailover(modelId, async (item) => { calls.push(item.channelId); return "answer"; });
    try {
      // Drain the earlier candidate read while the primary slot remains occupied.
      await getChannelCandidates(modelId);
      if (change === "unbound") await db.update(modelChannels).set({ enabled: false }).where(eq(modelChannels.channelId, candidate.channelId));
      else await db.update(channels).set(change === "disabled" ? { status: "disabled" } : { cooldownUntil: new Date(Date.now() + 60000) }).where(eq(channels.id, candidate.channelId));
    } finally { held.resolve(); await holding; }
    const result = await pending;
    assert.deepEqual(calls, [channelIds[1]]);
    assert.equal(result.candidate.channelId, channelIds[1]);
  });
}

test("a failed primary publishes its cooldown before another queued request can call it", async () => {
  const actionGate = deferred(), actionEntered = deferred(), writeGate = deferred(), writeEntered = deferred();
  let blocked = false;
  interceptHealthWrites(async (statement) => {
    if (!blocked && statement.includes('"last_failure_at"')) { blocked = true; writeEntered.resolve(); await writeGate.promise; }
  });
  const first = runWithFailover(modelId, async (candidate) => {
    if (candidate.channelId !== channelIds[0]) return "backup";
    actionEntered.resolve(); await actionGate.promise;
    throw new UpstreamError("busy upstream", "http_503", 503, "always");
  });
  await actionEntered.promise;
  const queuedCalls = [];
  const queued = runWithFailover(modelId, async (candidate) => { queuedCalls.push(candidate.channelId); return "queued answer"; });
  let prematureCalls;
  try {
    await getChannelCandidates(modelId);
    actionGate.resolve();
    await writeEntered.promise;
    await getChannelCandidates(modelId);
    prematureCalls = queuedCalls.slice();
  } finally { actionGate.resolve(); writeGate.resolve(); }
  await Promise.all([first, queued]);
  assert.deepEqual(prematureCalls, []);
  assert.deepEqual(queuedCalls, [channelIds[1]]);
});

test("a late success does not erase a newer failure and cooldown", async () => {
  await db.update(channels).set({ maxConcurrency: 2 }).where(eq(channels.id, channelIds[0]));
  const now = Date.now();
  mock.timers.enable({ apis: ["Date"], now });
  const gate = deferred(), entered = deferred();
  const first = runWithFailover(modelId, async () => { entered.resolve(); await gate.promise; return "earlier success"; });
  await entered.promise;
  let failureTime;
  try {
    mock.timers.setTime(now + 1000);
    await runWithFailover(modelId, async (candidate) => {
      if (candidate.channelId === channelIds[0]) throw new UpstreamError("invalid credential", "http_401", 401, "always");
      return "backup success";
    });
    failureTime = (await readChannel()).cooldownUntil.getTime();
    mock.timers.setTime(now + 2000);
  } finally { gate.resolve(); }
  assert.equal((await first).result, "earlier success");
  const primary = await readChannel();
  assert.equal(primary.lastErrorCode, "http_401");
  assert.equal(primary.cooldownUntil?.getTime(), failureTime);
});

test("health bookkeeping failure after success cannot trigger another generation", async () => {
  let failed = false;
  interceptHealthWrites(async () => { if (!failed) { failed = true; throw new Error("health write unavailable"); } });
  mock.method(console, "warn", () => {});
  const calls = [];
  const result = await runWithFailover(modelId, async (candidate) => { calls.push(candidate.channelId); return "already generated"; });
  assert.equal(result.result, "already generated");
  assert.deepEqual(calls, [channelIds[0]]);
});

test("health bookkeeping failure cannot stop an eligible fallback", async () => {
  let failed = false;
  interceptHealthWrites(async () => { if (!failed) { failed = true; throw new Error("health write unavailable"); } });
  mock.method(console, "warn", () => {});
  const calls = [];
  const result = await runWithFailover(modelId, async (candidate) => {
    calls.push(candidate.channelId);
    if (candidate.channelId === channelIds[0]) throw new UpstreamError("upstream failed", "http_503", 503, "always");
    return "backup answer";
  });
  assert.equal(result.result, "backup answer");
  assert.deepEqual(calls, channelIds.slice(0, 2));
});

test("cooldown expiry permits recovery and clears the previous error", async () => {
  await db.update(channels).set({ cooldownUntil: new Date(Date.now() - 1000), lastFailureAt: new Date(Date.now() - 301000), lastErrorCode: "http_401" }).where(eq(channels.id, channelIds[0]));
  const result = await runWithFailover(modelId, async () => "recovered");
  assert.equal(result.candidate.channelId, channelIds[0]);
  const recovered = await readChannel();
  assert.equal(recovered.cooldownUntil, null);
  assert.equal(recovered.lastErrorCode, null);
});
