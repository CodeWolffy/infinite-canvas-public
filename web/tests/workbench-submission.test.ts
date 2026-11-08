import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import stringify from "fast-json-stable-stringify";
import { beforeEach, expect, test, vi } from "vitest";
import { loadModule, readSource } from "./support/source-loader";

const records = new Map<string, unknown>();
const storage = {
    getItem: vi.fn(async (key: string) => records.get(key) || null),
    setItem: vi.fn(async (key: string, value: unknown) => { records.set(key, structuredClone(value)); }),
    removeItem: vi.fn(async (key: string) => { records.delete(key); }),
};
const state = { user: { id: "user-a" }, sessionVersion: 1 };
const createBatch = vi.fn();
const ensureMedia = vi.fn();
const locks = new Map<string, Promise<unknown>>();
const tabLocks = new Map<string, object>();
const tabContexts = new Map<object, object>();
function navigatorFor(sessionStorage: object) {
    const previous = tabContexts.get(sessionStorage);
    for (const [key, owner] of tabLocks) if (owner === previous) tabLocks.delete(key);
    const context = {};
    tabContexts.set(sessionStorage, context);
    return { locks: { request: (key: string, options: { ifAvailable: true } | (() => unknown), action?: (lock: object | null) => unknown) => {
        if (typeof options === "function") {
            const next = (locks.get(key) || Promise.resolve()).catch(() => undefined).then(options);
            locks.set(key, next);
            return next;
        }
        if (tabLocks.has(key)) return Promise.resolve(action!(null));
        tabLocks.set(key, context);
        return Promise.resolve().then(() => action!({ name: key })).finally(() => { if (tabLocks.get(key) === context) tabLocks.delete(key); });
    } } };
}
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
function tabStorage(copiedId?: string | null) {
    const values = new Map<string, string>();
    if (copiedId) values.set("infinite-canvas:generation-tab", copiedId);
    return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, clear: () => values.clear() };
}
const currentTab = tabStorage();
function client(sessionStorage = currentTab) {
    return loadModule(readSource("services/api/workbench-generation.ts"), { crypto: webcrypto, TextEncoder, Uint8Array, navigator: navigatorFor(sessionStorage), sessionStorage, DOMException }, {
        localforage: { default: { createInstance: () => storage } },
        "fast-json-stable-stringify": { default: stringify },
        "./generation": { createGenerationBatch: createBatch },
        "./request": { ApiError },
        "./tasks": { ensurePlatformMedia: ensureMedia },
        "@/stores/use-user-store": { useUserStore: { getState: () => state }, assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new DOMException("登录会话已变更", "AbortError"); } },
    }).submitWorkbenchGeneration;
}
const value = { capability: "image", modelId: "model", prompt: "生成一张图片", count: 1, parameters: { quality: "high", size: "1024x1024" }, references: [{ id: "ui-1", name: "参考图", type: "image/png", storageKey: "media:reference", dataUrl: "blob:preview" }] };
const valid = () => undefined;

test("读取本地参考文件期间切换输入，读取完成后不再上传", async () => {
    let changed = false;
    const upload = vi.fn();
    const tasks = loadModule(readSource("services/api/tasks.ts"), { DOMException }, {
        "./request": {},
        "./media": { uploadMedia: upload },
        "@/services/file-storage": { getMediaBlob: async () => { changed = true; return new Blob(["image"]); } },
        "@/stores/use-user-store": { useUserStore: { getState: () => state }, assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new DOMException("会话已变化", "AbortError"); } },
    });
    await expect(tasks.ensurePlatformMedia({ storageKey: "local-reference" }, undefined, () => { if (changed) throw new DOMException("输入已变化", "AbortError"); })).rejects.toMatchObject({ name: "AbortError" });
    expect(upload).not.toHaveBeenCalled();
});
const response = { batch: { id: "batch" }, tasks: [] };
beforeEach(() => {
    records.clear(); locks.clear(); tabLocks.clear(); tabContexts.clear(); currentTab.clear(); vi.clearAllMocks();
    state.user = { id: "user-a" }; state.sessionVersion = 1;
    storage.getItem.mockImplementation(async (key) => records.get(key) || null);
    storage.setItem.mockImplementation(async (key, data) => { records.set(key, structuredClone(data)); });
    storage.removeItem.mockImplementation(async (key) => { records.delete(key); });
    createBatch.mockReset().mockResolvedValue(response);
    ensureMedia.mockReset().mockResolvedValue("uploaded-media");
});

test("受理后回包丢失，刷新后原输入复用编号和上传结果", async () => {
    createBatch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client()(value, valid)).rejects.toThrow("尚未确认");
    const submitted = createBatch.mock.calls[0][0];
    expect(records.size).toBe(2);
    const result = await client()({ ...value, references: [{ ...value.references[0], id: "ui-2", dataUrl: "blob:new-preview" }] }, valid);
    expect(createBatch.mock.calls[1][0]).toEqual(submitted);
    expect(ensureMedia).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ...response, referenceMediaIds: ["uploaded-media"], referenceMedia: [{ mediaId: "uploaded-media", originalName: "参考图" }] });
    expect(records.size).toBe(0);
});

test("确认成功后的再次生成使用新编号", async () => {
    const submit = client();
    await submit(value, valid);
    await submit(value, valid);
    expect(createBatch.mock.calls[0][0].requestId).not.toBe(createBatch.mock.calls[1][0].requestId);
});

test("输入或账号不同互相隔离，返回原输入可继续恢复原请求", async () => {
    createBatch.mockRejectedValue(new Error("断线"));
    const submit = client();
    await expect(submit(value, valid)).rejects.toThrow();
    await expect(submit({ ...value, parameters: { ...value.parameters, quality: "low" } }, valid)).rejects.toThrow();
    state.user = { id: "user-b" }; state.sessionVersion++;
    await expect(submit(value, valid)).rejects.toThrow();
    state.user = { id: "user-a" }; state.sessionVersion++;
    createBatch.mockResolvedValue(response);
    await submit(value, valid);
    expect(new Set(createBatch.mock.calls.slice(0, 3).map(([input]) => input.requestId)).size).toBe(3);
    expect(createBatch.mock.calls[3][0]).toEqual(createBatch.mock.calls[0][0]);
    expect(records.size).toBe(4);
});

test.each(["getItem", "setItem"] as const)("%s 缓存失败不会发出无法恢复的生成请求", async (method) => {
    storage[method].mockRejectedValueOnce(new Error("IndexedDB failed"));
    await expect(client()(value, valid)).rejects.toThrow("本次未发起生成");
    expect(createBatch).not.toHaveBeenCalled();
});

test("准备素材期间切换输入或账号，不能提交旧准备", async () => {
    let changed = false;
    ensureMedia.mockImplementation(async () => { changed = true; return "prepared"; });
    await expect(client()(value, () => { if (changed) throw new DOMException("输入已改变", "AbortError"); })).rejects.toMatchObject({ name: "AbortError" });
    expect(createBatch).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    ensureMedia.mockImplementation(async () => { state.sessionVersion++; return "prepared"; });
    await expect(client()(value, valid)).rejects.toMatchObject({ name: "AbortError" });
    expect(createBatch).not.toHaveBeenCalled();
});

test("相同输入并发点击共享进行中的提交", async () => {
    const submit = client();
    let finish!: (value: unknown) => void;
    createBatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const one = submit(value, valid);
    const two = submit(value, valid);
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));
    finish(response);
    await Promise.all([one, two]);
    expect(createBatch).toHaveBeenCalledTimes(1);
});

test("多标签同时提交同一输入分配相同编号", async () => {
    const finish: Array<(result: unknown) => void> = [];
    createBatch.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    const one = client()(value, valid);
    const two = client(tabStorage())(value, valid);
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(2));
    expect(createBatch.mock.calls[1][0]).toEqual(createBatch.mock.calls[0][0]);
    expect(ensureMedia).toHaveBeenCalledTimes(1);
    finish.forEach((resolve) => resolve(response));
    await Promise.all([one, two]);
});

test.each(["retry", "refresh"])("A 标签成功后 B 标签回包丢失，B %s 仍恢复自己的原请求", async (mode) => {
    const finishes: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    createBatch.mockImplementation(() => new Promise((resolve, reject) => { finishes.push({ resolve, reject }); }));
    const secondTab = tabStorage();
    const submitB = client(secondTab);
    const one = client()(value, valid);
    const two = submitB(value, valid);
    const rejected = expect(two).rejects.toMatchObject({ name: "GenerationSubmissionUncertainError" });
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(2));
    const original = createBatch.mock.calls[0][0];
    expect(createBatch.mock.calls[1][0]).toEqual(original);
    finishes[0].resolve(response);
    await one;
    expect(records.size).toBe(1);
    finishes[1].reject(new TypeError("Failed to fetch"));
    await rejected;
    createBatch.mockResolvedValue(response);
    await (mode === "refresh" ? client(secondTab) : submitB)(value, valid);
    expect(createBatch.mock.calls[2][0]).toEqual(original);
    expect(ensureMedia).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(0);
});

test("复制标签页继承的标识独立占用，A 成功不会删除 B 的恢复记录", async () => {
    const finishes: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    createBatch.mockImplementation(() => new Promise((resolve, reject) => { finishes.push({ resolve, reject }); }));
    const one = client()(value, valid);
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));
    const copiedTab = tabStorage(currentTab.getItem("infinite-canvas:generation-tab"));
    const two = client(copiedTab)(value, valid);
    const rejected = expect(two).rejects.toThrow("尚未确认");
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(2));
    expect(copiedTab.getItem("infinite-canvas:generation-tab")).not.toBe(currentTab.getItem("infinite-canvas:generation-tab"));
    expect(createBatch.mock.calls[1][0]).toEqual(createBatch.mock.calls[0][0]);
    finishes[0].resolve(response);
    await one;
    finishes[1].reject(new TypeError("Failed to fetch"));
    await rejected;
    createBatch.mockResolvedValue(response);
    await client(copiedTab)(value, valid);
    expect(createBatch.mock.calls[2][0]).toEqual(createBatch.mock.calls[0][0]);
    expect(records.size).toBe(0);
});

test("旧标签恢复的迟到确认不清理其它标签再次生成的新请求", async () => {
    const finishes: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    createBatch.mockImplementation(() => new Promise((resolve, reject) => { finishes.push({ resolve, reject }); }));
    const submitA = client();
    const submitB = client(tabStorage());
    const one = submitA(value, valid);
    const two = submitB(value, valid);
    const rejected = expect(two).rejects.toThrow("尚未确认");
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(2));
    finishes[0].resolve(response);
    await one;
    const next = submitA(value, valid);
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(3));
    const original = createBatch.mock.calls[0][0].requestId;
    const nextId = createBatch.mock.calls[2][0].requestId;
    expect(nextId).not.toBe(original);
    finishes[1].reject(new TypeError("Failed to fetch"));
    await rejected;
    const recovered = submitB(value, valid);
    await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(4));
    expect(createBatch.mock.calls[3][0].requestId).toBe(original);
    finishes[3].resolve(response);
    await recovered;
    expect([...records.values()]).toHaveLength(2);
    expect([...records.values()].every((record) => (record as { input: { requestId: string } }).input.requestId === nextId)).toBe(true);
    finishes[2].resolve(response);
    await next;
    expect(records.size).toBe(0);
});

test("成功后缓存清理失败仍返回已受理结果并保留可恢复编号", async () => {
    storage.removeItem.mockRejectedValueOnce(new Error("缓存不可用"));
    const result = await client()(value, valid);
    expect(result.batch).toEqual(response.batch);
    expect(result.submissionWarning).toContain("生成已受理");
    expect(records.size).toBe(2);
});

test("收到拒绝响应后再次重试仍保持同一编号", async () => {
    createBatch.mockRejectedValueOnce(new ApiError("频率限制", 429));
    const submit = client();
    await expect(submit(value, valid)).rejects.toThrow("频率限制");
    await submit(value, valid);
    expect(createBatch.mock.calls[1][0].requestId).toBe(createBatch.mock.calls[0][0].requestId);
});

test.each([new TypeError("Failed to fetch"), new ApiError("内部错误", 500)])("网络或 5xx 返回可辨识的未确认错误", async (error) => {
    createBatch.mockRejectedValueOnce(error);
    await expect(client()(value, valid)).rejects.toMatchObject({ name: "GenerationSubmissionUncertainError" });
});

test("业务拒绝保留原错误", async () => {
    const error = new ApiError("余额不足", 400);
    createBatch.mockRejectedValueOnce(error);
    await expect(client()(value, valid)).rejects.toBe(error);
});
