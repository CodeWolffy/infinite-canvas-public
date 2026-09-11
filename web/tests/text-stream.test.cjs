const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function fixture(request) {
    const state = { sessionVersion: 1 };
    const subscribers = new Set();
    const streams = [];
    class Source {
        listeners = new Map();
        closed = false;
        constructor(url) { this.url = url; streams.push(this); }
        addEventListener(name, listener) { this.listeners.set(name, listener); }
        close() { this.closed = true; }
        emit(detail) { this.listeners.get("snapshot")?.({ data: JSON.stringify(detail) }); }
    }
    class ApiError extends Error {}
    const auth = {
        useUserStore: { getState: () => state, subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); } },
        assertCurrentSession: (version) => { if (state.sessionVersion !== version) throw new DOMException("session changed", "AbortError"); },
    };
    const imports = {
        "@/services/api/request": { ApiError, apiRequest: request || (() => Promise.resolve({ conversationId: "conversation", requestId: "request" })) },
        "@/stores/use-user-store": auth,
        "./tasks": { taskDelay: (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })) },
    };
    const module = { exports: {} };
    const source = readFileSync(resolve(__dirname, "../src/services/api/text.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(compiled, { module, exports: module.exports, require: (name) => imports[name], AbortController, DOMException, Event, EventSource: Source, window: { dispatchEvent: () => {} } });
    return { api: module.exports, streams, subscribers, replaceSession: () => { state.sessionVersion++; for (const listener of [...subscribers]) listener(state); } };
}
const snapshot = (sequence, text, status = "running", id = "request") => ({ request: { id, status, run: 1, streamSequence: sequence, partialText: text }, message: status === "succeeded" ? { id: "message", content: text } : null });

test("text stream ignores other requests, old revisions and late events after materialization", async () => {
    const f = fixture();
    const progress = [];
    const result = f.api.createTextRequest({ requestId: "request", modelId: "model", content: "question" }, undefined, (text) => progress.push(text));
    await new Promise(setImmediate);
    const stream = f.streams[0];
    stream.emit(snapshot(8, "wrong request", "running", "another"));
    stream.emit(snapshot(2, "partial"));
    stream.emit(snapshot(1, "old"));
    stream.emit(snapshot(3, "complete", "succeeded"));
    stream.emit(snapshot(4, "late"));
    assert.equal((await result).message.content, "complete");
    assert.deepEqual(progress, ["partial", "complete"]);
    assert.equal(stream.closed, true);
    assert.equal(f.subscribers.size, 0);
});

test("switching account closes SSE and discards an in-flight polling fallback", async () => {
    let finish;
    const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
    const received = [], errors = [];
    f.api.watchTextRequest("request", (value) => received.push(value), undefined, (error) => errors.push(error.name));
    f.streams[0].onerror();
    f.replaceSession();
    finish(snapshot(2, "previous account"));
    await Promise.resolve();
    f.streams[0].emit(snapshot(3, "late previous account"));
    assert.equal(received.length, 0);
    assert.deepEqual(errors, ["AbortError"]);
    assert.equal(f.streams[0].closed, true);
    assert.equal(f.subscribers.size, 0);
});

test("aborting local waiting disposes SSE without canceling the server task", () => {
    const requests = [];
    const f = fixture((path) => { requests.push(path); return Promise.resolve(); });
    const controller = new AbortController();
    let error;
    f.api.watchTextRequest("request", () => assert.fail("aborted stream emitted"), controller.signal, (reason) => { error = reason; });
    controller.abort();
    f.streams[0].emit(snapshot(1, "late"));
    assert.equal(error.name, "AbortError");
    assert.equal(f.streams[0].closed, true);
    assert.deepEqual(requests, []);
});

test("MFA challenge cannot mark the user authenticated before the second factor succeeds", async () => {
    const user = { id: "account", username: "example", role: "admin" };
    const imports = {
        zustand: require("zustand"),
        "@/services/api/auth": { login: async () => ({ mfaRequired: true, challenge: "challenge" }), completeMfa: async () => user },
        "@/services/api/user-center": {},
        "@/services/api/request": { ApiError: class extends Error {} },
    };
    const module = { exports: {} };
    const source = readFileSync(resolve(__dirname, "../src/stores/use-user-store.ts"), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { module, exports: module.exports, require: (name) => imports[name], DOMException });
    const store = module.exports.useUserStore;
    const challenge = await store.getState().login({ username: "example", password: "fixture" });
    assert.equal(challenge.mfaRequired, true);
    assert.equal(store.getState().user, null);
    assert.notEqual(store.getState().status, "authenticated");
    assert.equal(store.getState().sessionVersion, 0);
    await store.getState().completeMfa({ challenge: challenge.challenge, code: "fixture" });
    assert.equal(store.getState().user.id, "account");
    assert.equal(store.getState().status, "authenticated");
    assert.equal(store.getState().sessionVersion, 1);
});
