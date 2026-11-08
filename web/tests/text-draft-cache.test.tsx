import { useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const cache = vi.hoisted(() => ({ user: { id: "A" }, sessionVersion: 1, data: new Map<string, unknown>(), get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock("localforage", () => ({ default: { createInstance: () => ({ getItem: cache.get, setItem: cache.set, removeItem: cache.remove }) } }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: Object.assign((selector: (state: typeof cache) => unknown) => selector(cache), { getState: () => cache }) }));
vi.mock("@/services/api/media", () => ({ mediaId: (key: string) => key.replace(/^media:/, "") }));
import { useTextDraft, type TextInputDraft } from "@/pages/text/use-text-draft";

const empty = (): TextInputDraft => ({ prompt: "", modelId: "", systemPrompt: "", reasoningEffort: "auto", files: [] });
const key = (user = "A", conversation = "one") => JSON.stringify([user, conversation]);
function fixture(initial = empty()) {
    const restored = vi.fn();
    const hook = renderHook(({ conversationId }) => {
        const [value, setValue] = useState(initial);
        const draft = useTextDraft({ conversationId, value, onRestore: (next) => { restored(next); setValue(next); } });
        return { ...draft, value, setValue };
    }, { initialProps: { conversationId: "one" } });
    return { ...hook, restored };
}
beforeEach(() => {
    cache.user = { id: "A" }; cache.sessionVersion++; cache.data.clear();
    cache.get.mockReset().mockImplementation(async (id) => cache.data.get(id) || null);
    cache.set.mockReset().mockImplementation(async (id, value) => { cache.data.set(id, value); });
    cache.remove.mockReset().mockImplementation(async (id) => { cache.data.delete(id); });
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:restored-preview"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("刷新后恢复 Blob 附件和引用，重新创建预览且不存 object URL 或上传状态", async () => {
    const file = new File(["image"], "photo.png", { type: "image/png", lastModified: 123 });
    const initial = { ...empty(), prompt: "描述图片", files: [{ file, url: "blob:old-preview", status: "error", error: "upload failed" }, { reference: { id: "reference", name: "reference.png", type: "image/png", dataUrl: "", storageKey: "media:reference" }, url: "blob:reference-preview" }] } as TextInputDraft;
    const first = fixture(initial);
    await waitFor(() => expect(cache.data.has(key())).toBe(true));
    const saved = cache.data.get(key()) as { files: Array<Record<string, unknown>> };
    expect(saved.files[0].blob).toBe(file);
    expect(saved.files[0]).not.toHaveProperty("url");
    expect(saved.files[0]).not.toHaveProperty("status");
    expect(saved.files[1]).not.toHaveProperty("url");
    first.unmount();
    const next = fixture();
    await waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(next.result.current.value.prompt).toBe("描述图片");
    expect(next.result.current.value.files[0].file).toMatchObject({ name: "photo.png", type: "image/png", lastModified: 123, size: 5 });
    expect(next.result.current.value.files[0].url).toBe("blob:restored-preview");
    expect(next.result.current.value.files[1].url).toBe("/api/media/reference");
});

test("读取期间的新输入优先，未调用 markChanged 也不被迟到草稿覆盖", async () => {
    let resolve!: (value: TextInputDraft) => void;
    cache.get.mockImplementationOnce(() => new Promise((accept) => { resolve = accept; }));
    const hook = fixture();
    await waitFor(() => expect(cache.get).toHaveBeenCalled());
    act(() => hook.result.current.setValue({ ...empty(), prompt: "正在写的新内容" }));
    await act(async () => resolve({ ...empty(), prompt: "旧缓存" }));
    await waitFor(() => expect(cache.set).toHaveBeenCalled());
    expect(hook.restored).not.toHaveBeenCalled();
    expect(hook.result.current.value.prompt).toBe("正在写的新内容");
    expect(cache.data.get(key())).toMatchObject({ prompt: "正在写的新内容" });
});

test("输入版本改变后即使清空，旧读取也不能恢复已清空的内容", async () => {
    let resolve!: (value: TextInputDraft) => void;
    cache.get.mockImplementationOnce(() => new Promise((accept) => { resolve = accept; }));
    const hook = fixture();
    await waitFor(() => expect(cache.get).toHaveBeenCalled());
    act(() => hook.result.current.markChanged());
    await act(async () => resolve({ ...empty(), prompt: "清空前缓存" }));
    expect(hook.restored).not.toHaveBeenCalled();
    expect(hook.result.current.value.prompt).toBe("");
});

test("换账号后旧读取不恢复、不删除新账号数据，按账号和对话读取独立键", async () => {
    let resolve!: (value: TextInputDraft) => void;
    cache.get.mockImplementationOnce(() => new Promise((accept) => { resolve = accept; }));
    cache.data.set(key("B", "two"), { ...empty(), prompt: "B 的第二条对话" });
    const hook = fixture();
    await waitFor(() => expect(cache.get).toHaveBeenCalledWith(key()));
    act(() => { cache.user = { id: "B" }; cache.sessionVersion++; hook.rerender({ conversationId: "two" }); });
    await waitFor(() => expect(hook.result.current.value.prompt).toBe("B 的第二条对话"));
    await act(async () => resolve({ ...empty(), prompt: "A 的私人草稿" }));
    expect(hook.restored).toHaveBeenCalledTimes(1);
    expect(hook.result.current.value.prompt).toBe("B 的第二条对话");
    expect(cache.remove).not.toHaveBeenCalledWith(key("B", "two"));
    expect(cache.data.get(key("B", "two"))).toMatchObject({ prompt: "B 的第二条对话" });
});

test("发送后的清除排在此前保存之后，刷新不再恢复已发送内容", async () => {
    let finish!: () => void;
    cache.set.mockImplementationOnce(async (id, value) => { await new Promise<void>((resolve) => { finish = resolve; }); cache.data.set(id, value); });
    const hook = fixture({ ...empty(), prompt: "已发送问题" });
    await waitFor(() => expect(cache.set).toHaveBeenCalled());
    let clearing!: Promise<void>;
    act(() => { clearing = hook.result.current.clear(); });
    await act(async () => { finish(); await clearing; });
    expect(cache.data.has(key())).toBe(false);
});

test("缓存读取失败不拿空输入覆盖磁盘，后续主动输入成功保存后清除警告", async () => {
    cache.data.set(key(), { ...empty(), prompt: "暂时读不到的草稿" });
    cache.get.mockRejectedValueOnce(new Error("storage unavailable"));
    const hook = fixture();
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.error).toContain("读取失败");
    expect(cache.remove).not.toHaveBeenCalled();
    expect(cache.data.get(key())).toMatchObject({ prompt: "暂时读不到的草稿" });
    act(() => { hook.result.current.markChanged(); hook.result.current.setValue({ ...empty(), prompt: "主动输入的新草稿" }); });
    await waitFor(() => expect(hook.result.current.error).toBe(""));
    expect(cache.data.get(key())).toMatchObject({ prompt: "主动输入的新草稿" });
});

test("仅用户未提交的设置需要持久化，发送后残留的系统提示词不再遮蔽服务端设置", async () => {
    const settings = { ...empty(), modelId: "model", systemPrompt: "未提交的系统提示词", settingsDirty: true };
    const hook = fixture(settings);
    await waitFor(() => expect(cache.data.get(key())).toMatchObject({ settingsDirty: true, systemPrompt: settings.systemPrompt }));
    act(() => hook.result.current.setValue({ ...settings, settingsDirty: false }));
    await waitFor(() => expect(cache.data.has(key())).toBe(false));
    hook.unmount();
    const refreshed = fixture();
    await waitFor(() => expect(refreshed.result.current.ready).toBe(true));
    expect(refreshed.restored).not.toHaveBeenCalled();
});

test("提交幂等 ID 随完整输入持久化并在刷新恢复，写失败明确拒绝继续提交", async () => {
    const first = fixture({ ...empty(), prompt: "待提交的问题" });
    await waitFor(() => expect(cache.data.has(key())).toBe(true));
    const pending = { ...first.result.current.value, submission: { id: "request-1", fingerprint: "same-input", mediaIds: ["uploaded-image"] } };
    await act(async () => first.result.current.persistPending(pending));
    first.unmount();
    const refreshed = fixture();
    await waitFor(() => expect(refreshed.result.current.value.submission).toEqual(pending.submission));
    expect(refreshed.result.current.value.prompt).toBe(pending.prompt);
    cache.set.mockRejectedValueOnce(new Error("storage full"));
    await act(async () => { await expect(refreshed.result.current.persistPending(pending)).rejects.toThrow("storage full"); });
    expect(refreshed.result.current.error).toContain("提交前草稿保存失败");
    await act(async () => refreshed.result.current.clear("request-1"));
    expect(cache.data.has(key())).toBe(false);
});

test("离页后迟到成功按提交 ID 清理，等待新草稿保存且不删除新输入或新提交", async () => {
    const first = fixture({ ...empty(), prompt: "已经提交" });
    await waitFor(() => expect(cache.data.has(key())).toBe(true));
    await act(async () => first.result.current.persistPending({ ...first.result.current.value, submission: { id: "old-request", fingerprint: "old" } }));
    const oldClear = first.result.current.clear;
    first.unmount();
    const returned = fixture();
    await waitFor(() => expect(returned.result.current.value.submission?.id).toBe("old-request"));
    let finish!: () => void;
    cache.set.mockImplementationOnce(async (id, value) => { await new Promise<void>((resolve) => { finish = resolve; }); cache.data.set(id, value); });
    act(() => { returned.result.current.markChanged(); returned.result.current.setValue({ ...empty(), prompt: "返回后新写的问题" }); });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    let clearing!: Promise<void>;
    act(() => { clearing = oldClear("old-request"); });
    await act(async () => { finish(); await clearing; });
    expect(cache.data.get(key())).toMatchObject({ prompt: "返回后新写的问题" });
    await act(async () => returned.result.current.persistPending({ ...returned.result.current.value, submission: { id: "new-request", fingerprint: "new" } }));
    await act(async () => oldClear("old-request"));
    expect(cache.data.get(key())).toMatchObject({ submission: { id: "new-request" } });
});
