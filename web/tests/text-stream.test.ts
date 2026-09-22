import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { loadModule, readSource } from "./support/source-loader";

const nodeRequire = createRequire(import.meta.url);

function fixture(request?: (path: string) => Promise<any>) {
    const state = { sessionVersion: 1 };
    const subscribers = new Set<(state: any) => void>();
    const streams: any[] = [];
    class Source {
        listeners = new Map<string, (event: any) => void>();
        closed = false;
        url: string;
        constructor(url: string) { this.url = url; streams.push(this); }
        addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener); }
        close() { this.closed = true; }
        emit(detail: any) { this.listeners.get("snapshot")?.({ data: JSON.stringify(detail) }); }
        onerror: (() => void) | undefined;
    }
    class ApiError extends Error {}
    const auth = {
        useUserStore: { getState: () => state, subscribe: (listener: (state: any) => void) => { subscribers.add(listener); return () => subscribers.delete(listener); } },
        assertCurrentSession: (version: number) => { if (state.sessionVersion !== version) throw new DOMException("session changed", "AbortError"); },
    };
    const imports = {
        "@/services/api/request": { ApiError, apiRequest: request || (() => Promise.resolve({ conversationId: "conversation", requestId: "request" })) },
        "@/stores/use-user-store": auth,
        "./tasks": { taskDelay: (signal: AbortSignal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })) },
    };
    const api = loadModule(readSource("services/api/text.ts"), { AbortController, DOMException, Event, EventSource: Source, window: { dispatchEvent: () => {} } }, imports);
    return { api, streams, subscribers, replaceSession: () => { state.sessionVersion++; for (const listener of [...subscribers]) listener(state); } };
}
const snapshot = (sequence: number, text: string, status = "running", id = "request") => ({ request: { id, status, run: 1, streamSequence: sequence, partialText: text }, message: status === "succeeded" ? { id: "message", content: text } : null });

test("text stream ignores other requests, old revisions and late events after materialization", async () => {
    const f = fixture();
    const progress: string[] = [];
    const result = f.api.createTextRequest({ requestId: "request", modelId: "model", content: "question" }, undefined, (text: string) => progress.push(text));
    await new Promise(setImmediate);
    const stream = f.streams[0];
    stream.emit(snapshot(8, "wrong request", "running", "another"));
    stream.emit(snapshot(2, "partial"));
    stream.emit(snapshot(1, "old"));
    stream.emit(snapshot(3, "complete", "succeeded"));
    stream.emit(snapshot(4, "late"));
    expect((await result).message.content).toBe("complete");
    expect(progress).toEqual(["partial", "complete"]);
    expect(stream.closed).toBe(true);
    expect(f.subscribers.size).toBe(0);
});

test("switching account closes SSE and discards an in-flight polling fallback", async () => {
    let finish: (value: any) => void;
    const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
    const received: any[] = [], errors: string[] = [];
    f.api.watchTextRequest("request", (value: any) => received.push(value), undefined, (error: any) => errors.push(error.name));
    f.streams[0].onerror();
    f.replaceSession();
    finish!(snapshot(2, "previous account"));
    await Promise.resolve();
    f.streams[0].emit(snapshot(3, "late previous account"));
    expect(received.length).toBe(0);
    expect(errors).toEqual(["AbortError"]);
    expect(f.streams[0].closed).toBe(true);
    expect(f.subscribers.size).toBe(0);
});

test("aborting local waiting disposes SSE without canceling the server task", () => {
    const requests: string[] = [];
    const f = fixture((path) => { requests.push(path); return Promise.resolve(); });
    const controller = new AbortController();
    let error: any;
    f.api.watchTextRequest("request", () => expect.fail("aborted stream emitted"), controller.signal, (reason: any) => { error = reason; });
    controller.abort();
    f.streams[0].emit(snapshot(1, "late"));
    expect(error.name).toBe("AbortError");
    expect(f.streams[0].closed).toBe(true);
    expect(requests).toEqual([]);
});

test("MFA challenge cannot mark the user authenticated before the second factor succeeds", async () => {
    const user = { id: "account", username: "example", role: "admin" };
    const imports = {
        zustand: nodeRequire("zustand"),
        "@/services/api/auth": { login: async () => ({ mfaRequired: true, challenge: "challenge" }), completeMfa: async () => user },
        "@/services/api/user-center": {},
        "@/services/api/request": { ApiError: class extends Error {} },
    };
    const store = loadModule(readSource("stores/use-user-store.ts"), { DOMException }, imports).useUserStore;
    const challenge = await store.getState().login({ username: "example", password: "fixture" });
    expect(challenge.mfaRequired).toBe(true);
    expect(store.getState().user).toBe(null);
    expect(store.getState().status).not.toBe("authenticated");
    expect(store.getState().sessionVersion).toBe(0);
    await store.getState().completeMfa({ challenge: challenge.challenge, code: "fixture" });
    expect(store.getState().user.id).toBe("account");
    expect(store.getState().status).toBe("authenticated");
    expect(store.getState().sessionVersion).toBe(1);
});
