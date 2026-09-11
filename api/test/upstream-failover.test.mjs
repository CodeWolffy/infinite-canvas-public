import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@invalid.invalid/test",
  CHANNEL_ENCRYPTION_KEY: "upstream-failover-test-encryption-key",
  MINIO_ENDPOINT: "invalid.invalid",
  MINIO_ACCESS_KEY: "test-access",
  MINIO_SECRET_KEY: "test-secret",
});

const { generateImage, generateText } = await import("../src/upstream.ts");
const { UpstreamError } = await import("../src/channel-scheduler.ts");
const candidate = (protocol) => ({ protocol, apiKey: "sk-synthetic-failover-test-key", baseUrl: "https://models.example.test/v1", upstreamModel: "test-model", timeoutMs: 480000 });
const generate = {
  image: (protocol) => generateImage(candidate(protocol), "test prompt", {}, []),
  text: (protocol) => generateText(candidate(protocol), [{ role: "user", content: "test prompt" }], {}),
};

afterEach(() => mock.restoreAll());

function respond(body, status = 200) {
  mock.restoreAll();
  return mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

async function rejectsAs(request, category, failover, httpStatus) {
  await assert.rejects(request, (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.category, category);
    assert.equal(error.failover, failover);
    if (httpStatus !== undefined) assert.equal(error.httpStatus, httpStatus);
    return true;
  });
}

test("Gemini HTTP-200 prompt and candidate safety refusals never fail over for image or text", async () => {
  for (const body of [
    { promptFeedback: { blockReason: "SAFETY" } },
    { promptFeedback: { blockReason: "BLOCKLIST" } },
    { candidates: [{ finishReason: "SAFETY" }] },
    { candidates: [{ finishReason: "IMAGE_SAFETY" }] },
    { candidates: [{ finishReason: "PROHIBITED_CONTENT" }] },
    { candidates: [{ finishReason: "IMAGE_PROHIBITED_CONTENT" }] },
    { candidates: [{ finishReason: "BLOCKLIST" }] },
    { candidates: [{ finishReason: "RECITATION" }] },
    { candidates: [{ finishReason: "SPII" }] },
  ]) {
    for (const run of Object.values(generate)) {
      respond(body);
      await rejectsAs(run("gemini"), "content_policy", "never", 200);
    }
  }
});

test("OpenAI HTTP-200 refusal and content-filter results stop text failover", async () => {
  for (const body of [
    { choices: [{ message: { content: null, refusal: "I cannot help with this request." }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] },
  ]) {
    respond(body);
    await rejectsAs(generate.text("openai"), "content_policy", "never", 200);
  }
});

test("HTTP errors distinguish explicit policy refusals from safety-service outages", async () => {
  for (const [status, body, category, failover] of [
    [503, { error: { message: "Content safety service unavailable" } }, "http_503", "always"],
    [429, { error: { message: "Rate limit exceeded in content moderation service" } }, "http_429", "always"],
    [400, { error: { code: "content_filter", message: "Request rejected" } }, "content_policy", "never"],
    [400, { error: { type: "content_policy_violation", message: "Request failed" } }, "content_policy", "never"],
    [503, { error: { code: "moderation_blocked", message: "Request rejected" } }, "content_policy", "never"],
    [400, { error: { message: "Your request was rejected as a result of our safety system." } }, "content_policy", "never"],
    [400, { error: { message: "The prompt is considered unsafe." } }, "content_policy", "never"],
    [451, { error: { message: "Request blocked" } }, "content_policy", "never"],
    [400, { error: { message: "Invalid image size" } }, "invalid_request", "never"],
    [401, { error: { message: "Invalid API key" } }, "http_401", "always"],
  ]) {
    for (const run of Object.values(generate)) {
      respond(body, status);
      await rejectsAs(run("openai"), category, failover, status);
    }
  }
});

test("null and malformed text envelopes consistently allow one fallback without TypeError", async () => {
  for (const protocol of ["openai", "gemini"]) {
    const malformed = protocol === "openai"
      ? [{ choices: { 0: { message: { content: "not an array" } } } }, { choices: [null] }, { choices: [{ message: { content: {} } }] }]
      : [{ candidates: { 0: { content: { parts: [{ text: "not an array" }] } } } }, { candidates: [null] }, { candidates: [{ content: { parts: {} } }] }, { candidates: [{ content: { parts: [null] } }] }];
    for (const body of [null, [], "invalid envelope", ...malformed]) {
      respond(body);
      await rejectsAs(generate.text(protocol), "invalid_response", "once");
    }
  }
});

test("valid image and text outputs retain decoding, system roles, and reasoning parameters", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y8akAAAAASUVORK5CYII=", "base64");
  const messages = [{ role: "system", content: "system instruction" }, { role: "user", content: "question" }];
  respond({ data: [{ b64_json: bytes.toString("base64") }] });
  assert.deepEqual(await generate.image("openai"), bytes);
  respond({ promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" }, candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: bytes.toString("base64") } }] } }] });
  assert.deepEqual(await generate.image("gemini"), bytes);

  const openai = respond({ choices: [{ finish_reason: "stop", message: { content: "accepted answer", refusal: null } }] });
  assert.equal(await generateText(candidate("openai"), messages, { reasoningEffort: "high" }), "accepted answer");
  const openaiBody = JSON.parse(openai.mock.calls[0].arguments[1].body);
  assert.deepEqual(openaiBody.messages, messages);
  assert.equal(openaiBody.reasoning_effort, "high");

  const gemini = respond({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "accepted " }, { text: "answer" }] } }] });
  assert.equal(await generateText(candidate("gemini"), messages, { temperature: 0.5 }), "accepted answer");
  const geminiBody = JSON.parse(gemini.mock.calls[0].arguments[1].body);
  assert.deepEqual(geminiBody.systemInstruction, { parts: [{ text: "system instruction" }] });
  assert.deepEqual(geminiBody.contents, [{ role: "user", parts: [{ text: "question" }] }]);
  assert.equal(geminiBody.generationConfig.temperature, 0.5);
});

test("transport errors and invalid JSON keep their existing failover classifications", async () => {
  for (const protocol of ["openai", "gemini"]) {
    for (const run of Object.values(generate)) {
      for (const [failure, category, failover] of [
        [new TypeError("synthetic connection failure"), "network", "always"],
        [new DOMException("synthetic timeout", "AbortError"), "timeout", "always"],
        [null, "invalid_response", "once"],
      ]) {
        mock.restoreAll();
        mock.method(globalThis, "fetch", async () => {
          if (failure) throw failure;
          return new Response("invalid JSON", { status: 200 });
        });
        await rejectsAs(run(protocol), category, failover);
      }
    }
  }
});
