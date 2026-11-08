import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ zip: vi.fn(), create: vi.fn(), upload: vi.fn(), meta: vi.fn() }));
vi.mock("@/lib/zip", () => ({ readZip: api.zip, createZip: vi.fn() }));
vi.mock("@/services/api/assets", () => ({ createAsset: api.create }));
vi.mock("@/services/api/media", () => ({ uploadMedia: api.upload, mediaUrl: (id: string) => `/api/media/${id}`, mediaId: (key: string) => key.replace(/^(?:image|media):/, ""), readMedia: vi.fn() }));
vi.mock("@/lib/image-utils", () => ({ readImageMeta: api.meta }));
vi.mock("@/lib/image-thumbnail", () => ({ createImageThumbnail: async () => undefined }));
vi.mock("localforage", () => ({ default: { createInstance: () => ({ getItem: async () => ({ version: 1 }), setItem: async () => undefined }) } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    const useUserStore = create(() => ({ sessionVersion: 1, user: { id: "owner" } }));
    return { useUserStore, assertCurrentSession: (version: number) => { if (version !== useUserStore.getState().sessionVersion) throw new DOMException("会话已变化", "AbortError"); } };
});
import { useAssetImport } from "@/pages/assets/use-asset-import";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}
const image = (title = "图片", key = "old") => ({ kind: "image", title, tags: [], scope: "private", data: { storageKey: key, dataUrl: "old-url", width: 100, height: 200, bytes: 4, mimeType: "image/png" } });
const text = (title = "文本") => ({ kind: "text", title, tags: [], scope: "private", data: { content: "正文" } });
const metadata = { width: 100, height: 200, mimeType: "image/png" };
const upload = { id: "uploaded", url: "/api/media/uploaded", byteSize: 4, ...metadata };
function archive(assets: unknown[], includeMedia = true) {
    return new Map<string, unknown>([
        ["assets.json", { text: async () => JSON.stringify({ app: "infinite-canvas", version: 1, assets, files: [{ storageKey: "old", path: "image.png", mimeType: "image/png" }] }) }],
        ...(includeMedia ? [["image.png", new Blob(["data"], { type: "image/png" })] as [string, Blob]] : []),
    ]);
}
const file = () => new File(["zip"], "素材包.zip", { type: "application/zip" });
beforeEach(() => {
    useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 }));
    api.zip.mockReset().mockResolvedValue(archive([text(), image()]));
    api.meta.mockReset().mockResolvedValue(metadata);
    api.upload.mockReset().mockResolvedValue(upload);
    api.create.mockReset().mockImplementation(async (input) => ({ ...input, id: input.requestId, revision: 0, ownerId: "owner", createdAt: "2026-01-01", updatedAt: "2026-01-01" }));
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:prepared"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("媒体上传失败不影响其他素材成功，重试仅处理失败项", async () => {
    api.upload.mockRejectedValueOnce(new Error("上传失败"));
    const { result } = renderHook(() => useAssetImport(vi.fn()));
    await act(async () => result.current.start(file()));
    expect(result.current.items.map((item) => item.status)).toEqual(["succeeded", "failed"]);
    expect(api.create).toHaveBeenCalledTimes(1);
    await act(async () => result.current.retry());
    expect(result.current.items.map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
    expect(api.create.mock.calls.map(([input]) => input.title)).toEqual(["文本", "图片"]);
    expect(api.upload).toHaveBeenCalledTimes(2);
});

test("创建响应丢失后复用已上传媒体和同一请求编号，成功项不会重建", async () => {
    let failed = false;
    api.create.mockImplementation(async (input) => {
        if (input.title === "图片" && !failed) { failed = true; throw new Error("响应丢失"); }
        return { ...input, id: input.requestId, revision: 0, ownerId: "owner" };
    });
    const { result } = renderHook(() => useAssetImport(vi.fn()));
    await act(async () => result.current.start(file()));
    const failedInput = api.create.mock.calls[1][0];
    await act(async () => result.current.retry());
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[2][0]).toEqual(failedInput);
    expect(api.create.mock.calls.filter(([input]) => input.title === "文本")).toHaveLength(1);
    expect(useAssetStore.getState().assets).toHaveLength(2);
});

test("缺失文件只使对应素材失败，共享文件成功上传后供各条目复用", async () => {
    api.zip.mockResolvedValue(archive([image("第一项"), image("第二项"), image("缺失项", "missing"), text()]));
    const { result } = renderHook(() => useAssetImport(vi.fn()));
    await act(async () => result.current.start(file()));
    expect(result.current.items.map((item) => item.status)).toEqual(["succeeded", "succeeded", "failed", "succeeded"]);
    expect(result.current.items[2].error).toContain("缺少对应媒体文件");
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledTimes(3);
});

test.each(["更换素材包", "切换会话", "卸载"])("解压期间%s，迟到包不上传、不创建、不覆盖结果", async (change) => {
    const pending = deferred<ReturnType<typeof archive>>(); api.zip.mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useAssetImport(vi.fn()));
    let starting!: Promise<void>;
    act(() => { starting = view.result.current.start(file()); });
    if (change === "卸载") view.unmount();
    else if (change === "切换会话") act(() => useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 })));
    else { act(() => view.result.current.clear()); api.zip.mockResolvedValue(archive([text("新素材包")])); await act(async () => view.result.current.start(file())); }
    await act(async () => { pending.resolve(archive([image()])); await starting; });
    expect(api.upload).not.toHaveBeenCalled();
    expect(api.create.mock.calls.map(([input]) => input.title)).toEqual(change === "更换素材包" ? ["新素材包"] : []);
});

test("图片准备期间清除导入，准备完成后不发上传请求", async () => {
    const pending = deferred<typeof metadata>(); api.meta.mockReturnValueOnce(pending.promise);
    api.zip.mockResolvedValue(archive([image()]));
    const { result } = renderHook(() => useAssetImport(vi.fn()));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(file()); });
    await waitFor(() => expect(api.meta).toHaveBeenCalledTimes(1));
    act(() => result.current.clear());
    await act(async () => { pending.resolve(metadata); await starting; });
    expect(api.upload).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
});

test("上传在切号后完成，不把旧素材创建到新账号", async () => {
    const pending = deferred<typeof upload>(); api.upload.mockReturnValueOnce(pending.promise);
    api.zip.mockResolvedValue(archive([image()]));
    const { result } = renderHook(() => useAssetImport(vi.fn()));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(file()); });
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    act(() => useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 })));
    await act(async () => { pending.resolve(upload); await starting; });
    expect(api.create).not.toHaveBeenCalled(); expect(result.current.items).toEqual([]);
});
