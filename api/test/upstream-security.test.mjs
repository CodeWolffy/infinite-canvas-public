import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { afterEach, mock, test } from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@invalid.invalid/test",
  CHANNEL_ENCRYPTION_KEY: "upstream-security-test-encryption-key",
  MINIO_ENDPOINT: "invalid.invalid",
  MINIO_ACCESS_KEY: "test-access",
  MINIO_SECRET_KEY: "test-secret",
  ALLOW_PRIVATE_IMAGE_HOSTS: "false",
  MAX_GENERATED_BYTES: "8",
});

const { downloadImage, generateText } = await import("../src/upstream.ts");
const { config } = await import("../src/config.ts");

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function mockDownloads(resolveAddresses, responseFor = () => ({ status: 200, body: "image" })) {
  mock.restoreAll();
  syncBuiltinESMExports();
  const connections = [];
  let lookupCount = 0;
  const resolve = (hostname) => {
    lookupCount += 1;
    return resolveAddresses(hostname, lookupCount);
  };
  mock.method(dnsPromises, "lookup", async (hostname) => resolve(hostname));
  mock.method(dns, "lookup", (hostname, _options, callback) => callback(null, resolve(hostname)));

  const request = (target, options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const hostname = target.hostname.replace(/^\[|\]$/g, "");
      const respond = (address) => {
        connections.push(address);
        const fixture = responseFor(target);
        const response = Readable.from([Buffer.from(fixture.body ?? "")]);
        response.statusCode = fixture.status;
        response.headers = fixture.headers ?? {};
        onResponse(response);
      };
      if (isIP(hostname)) return respond(hostname);
      options.lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return req.emit("error", error);
        respond(Array.isArray(addresses) ? addresses[0].address : addresses);
      });
    });
    return req;
  };
  mock.method(http, "request", request);
  mock.method(https, "request", request);
  // The old fetch path resolves again after its DNS preflight.
  mock.method(globalThis, "fetch", async (target) => {
    const url = new URL(target);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    connections.push(isIP(hostname) ? hostname : resolve(hostname)[0].address);
    const fixture = responseFor(url);
    return new Response(fixture.body ?? "", { status: fixture.status, headers: fixture.headers });
  });
  syncBuiltinESMExports();
  return { connections, lookupCount: () => lookupCount };
}

test("rejects mapped IPv6 private addresses before opening a connection", async () => {
  const network = mockDownloads(() => []);
  for (const address of ["::ffff:127.0.0.1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "::1", "fd00::1"]) {
    await assert.rejects(downloadImage(`http://[${address}]/image.png`), (error) => error.category === "blocked_image_host");
  }
  assert.equal(network.connections.length, 0);
});

test("connects to the same public address that passed DNS validation", async () => {
  const network = mockDownloads((_hostname, count) => [{ address: count === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }]);
  assert.equal((await downloadImage("https://images.example.test/result.png")).toString(), "image");
  assert.deepEqual(network.connections, ["8.8.8.8"]);
  assert.equal(network.lookupCount(), 1);
});

test("rejects a DNS result containing both public and private addresses", async () => {
  const network = mockDownloads(() => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  await assert.rejects(downloadImage("http://images.example.test/result.png"), (error) => error.category === "blocked_image_host");
  assert.equal(network.connections.length, 0);
});

test("validates redirected destinations before following them", async () => {
  const network = mockDownloads(
    () => [{ address: "8.8.8.8", family: 4 }],
    (target) => target.hostname === "images.example.test"
      ? { status: 302, headers: { location: "http://[::ffff:7f00:1]/private.png" } }
      : { status: 200, body: "private" },
  );
  await assert.rejects(downloadImage("https://images.example.test/result.png"), (error) => error.category === "blocked_image_host");
  assert.deepEqual(network.connections, ["8.8.8.8"]);
});

test("still downloads public IPv4 and IPv6 literal destinations", async () => {
  const network = mockDownloads(() => []);
  for (const target of ["http://8.8.8.8/result.png", "https://[2001:4860:4860::8888]/result.png"]) {
    assert.equal((await downloadImage(target)).toString(), "image");
  }
  assert.equal(network.connections.length, 2);
  assert.equal(network.lookupCount(), 0);
});

test("enforces the existing download byte limit with and without Content-Length", async () => {
  for (const headers of [{ "content-length": "9" }, {}]) {
    mockDownloads(() => [], () => ({ status: 200, body: "123456789", headers }));
    await assert.rejects(downloadImage("https://8.8.8.8/result.png"), (error) => error.category === "image_too_large");
  }
});

test("stops after the existing four redirect hops", async () => {
  const network = mockDownloads(() => [], () => ({ status: 302, headers: { location: "/next.png" } }));
  await assert.rejects(downloadImage("https://8.8.8.8/result.png"), (error) => error.category === "image_download");
  assert.equal(network.connections.length, 4);
});

test("explicit private-host opt-in still downloads bytes from a local gateway", async () => {
  const bytes = Buffer.from([0, 255, 1, 254]);
  const server = http.createServer((_request, reply) => reply.end(bytes));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.ALLOW_PRIVATE_IMAGE_HOSTS = true;
  try {
    assert.deepEqual(await downloadImage(`http://127.0.0.1:${server.address().port}/image.png`), bytes);
  } finally {
    config.ALLOW_PRIVATE_IMAGE_HOSTS = false;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("redacts reflected channel credentials before truncating upstream errors", async () => {
  const apiKey = randomBytes(48).toString("base64url");
  const candidate = { protocol: "openai", apiKey, baseUrl: "https://models.example.test/v1", upstreamModel: "test-model", timeoutMs: 480000 };
  let responseBody;
  mock.method(globalThis, "fetch", async () => new Response(responseBody, { status: 401 }));
  for (const body of [
    `Incorrect API key: ${apiKey}`,
    JSON.stringify({ error: { message: `${"x".repeat(975)}${apiKey}` } }),
  ]) {
    responseBody = body;
    await assert.rejects(generateText(candidate, [{ role: "user", content: "test" }], {}), (error) => {
      assert.equal(error.httpStatus, 401);
      assert.equal(error.message.includes(apiKey.slice(0, 16)), false);
      assert.equal(error.message.includes("[REDACTED]"), true);
      return true;
    });
  }
});

test("redacts JSON-escaped channel credentials", async () => {
  const apiKey = `${randomBytes(16).toString("base64url")}\\"`;
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: `Credential: ${apiKey}` } }), { status: 401 }));
  await assert.rejects(generateText({ protocol: "openai", apiKey, baseUrl: "https://models.example.test/v1", upstreamModel: "test-model", timeoutMs: 480000 }, [], {}), (error) => {
    assert.equal(error.message.includes(apiKey.slice(0, 16)), false);
    assert.equal(error.message.includes("[REDACTED]"), true);
    return true;
  });
});

test("redacts credentials decoded from alternate JSON escapes", async () => {
  const apiKey = `sk-${randomBytes(24).toString("base64url")}/key`;
  const candidate = { protocol: "openai", apiKey, baseUrl: "https://models.example.test/v1", upstreamModel: "test-model", timeoutMs: 480000 };
  let responseBody;
  mock.method(globalThis, "fetch", async () => new Response(responseBody, { status: 401 }));
  const message = `Credential: ${apiKey}`;
  for (const body of [
    JSON.stringify({ error: { message } }).replace("sk-", "\\u0073k-"),
    JSON.stringify({ error: { message } }).replaceAll("/", "\\/"),
    JSON.stringify({ error: { message }, detail: "x".repeat(2100) }).replace("sk-", "\\u0073k-"),
    JSON.stringify({ detail: message }).replace("sk-", "\\u0073k-"),
  ]) {
    responseBody = body;
    await assert.rejects(generateText(candidate, [], {}), (error) => {
      assert.equal(error.message.includes(apiKey), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
  }
});
