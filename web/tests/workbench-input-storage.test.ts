import { Blob } from "node:buffer";
import { beforeEach, expect, test, vi } from "vitest";
import { loadModule, readSource } from "./support/source-loader";

const records = new Map<string, unknown>();
const state = { user: { id: "a" }, sessionVersion: 1 };
const storage = { getItem: vi.fn(), setItem: vi.fn() };
const api = loadModule(readSource("stores/workbench-input-storage.ts"), { DOMException, structuredClone }, {
    localforage: { default: { createInstance: () => storage } },
    "@/stores/use-user-store": { useUserStore: { getState: () => state }, assertCurrentSession: (session: number) => { if (session !== state.sessionVersion) throw new DOMException("登录会话已变更", "AbortError"); } },
});
const valid = () => undefined;

beforeEach(() => {
    records.clear(); state.user = { id: "a" }; state.sessionVersion = 1;
    storage.getItem.mockReset().mockImplementation(async (key) => records.get(key) || null);
    storage.setItem.mockReset().mockImplementation(async (key, value) => { records.set(key, value); });
});

test("完整草稿和文件按账号、工作台隔离，读回保留文件字节", async () => {
    const value = { prompt: "图片草稿", settings: { quality: "high" }, uploads: [{ blob: new Blob(["file-bytes"], { type: "image/png" }), name: "参考图" }] };
    await api.writeWorkbenchInput("image", value, 1, valid);
    await api.writeWorkbenchInput("video", { prompt: "视频草稿" }, 1, valid);
    state.user = { id: "b" }; state.sessionVersion++;
    await expect(api.readWorkbenchInput("image", 2)).resolves.toBeNull();
    await api.writeWorkbenchInput("image", { prompt: "另一账号" }, 2, valid);
    state.user = { id: "a" }; state.sessionVersion++;
    const saved = await api.readWorkbenchInput("image", 3);
    expect(saved.prompt).toBe("图片草稿");
    expect(saved.settings).toEqual({ quality: "high" });
    expect(await saved.uploads[0].blob.text()).toBe("file-bytes");
    expect(await api.readWorkbenchInput("video", 3)).toEqual({ prompt: "视频草稿" });
});

test("迟到旧写入不能越过新输入，读取等待最新写入完成", async () => {
    let finish!: () => void;
    storage.setItem.mockImplementationOnce((key, value) => new Promise<void>((resolve) => { finish = () => { records.set(key, value); resolve(); }; }));
    const first = api.writeWorkbenchInput("image", { prompt: "旧输入" }, 1, valid);
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    const newer = api.writeWorkbenchInput("image", { prompt: "新输入" }, 1, valid);
    const read = api.readWorkbenchInput("image", 1);
    finish();
    await Promise.all([first, newer]);
    await expect(read).resolves.toEqual({ prompt: "新输入" });
});

test("排队期间输入版本或登录会话变化时拒绝写回", async () => {
    const changed = () => { throw new DOMException("输入变化", "AbortError"); };
    await expect(api.writeWorkbenchInput("image", { prompt: "过期输入" }, 1, changed)).rejects.toMatchObject({ name: "AbortError" });
    const save = api.writeWorkbenchInput("image", { prompt: "旧账号输入" }, 1, valid);
    state.sessionVersion++;
    await expect(save).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.setItem).not.toHaveBeenCalled();
});

test("旧账号读请求迟到时不返回旧草稿", async () => {
    let finish!: (value: unknown) => void;
    storage.getItem.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const read = api.readWorkbenchInput("image", 1);
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledTimes(1));
    state.sessionVersion++;
    finish({ prompt: "旧账号输入" });
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
});
