import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useWorkbenchReferenceUploads } from "@/hooks/use-workbench-reference-uploads";
import type { ReferenceImage } from "@/types/image";

const api = vi.hoisted(() => ({ upload: vi.fn(), preview: vi.fn() }));
vi.mock("@/services/api/generation", () => ({ uploadGenerationMedia: api.upload }));
vi.mock("@/services/image-storage", () => ({ ensureImagePreview: api.preview }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const file = (name: string, type = "image/png") => new File([name], name, { type });
const media = (id: string, mimeType = "image/png") => ({ id, url: `/api/media/${id}`, mimeType });
const reference = (id: string): ReferenceImage => ({ id, name: id, type: "image/png", dataUrl: `/api/media/${id}`, storageKey: id });
function mount(initialReferences: ReferenceImage[] = [], maxCount?: number) {
    const scope = { session: 1, input: 1 };
    const hook = renderHook(({ sessionVersion }) => useWorkbenchReferenceUploads({
        initialReferences, maxCount, sessionVersion,
        captureInputScope: () => {
            const { session, input } = scope;
            return () => { if (scope.session !== session || scope.input !== input) throw new DOMException("输入已改变", "AbortError"); };
        },
        supportsType: (type) => ["image/png", "image/jpeg", "image/webp"].includes(type),
        unsupportedMessage: "仅支持图片文件",
    }), { initialProps: { sessionVersion: 1 } });
    return { ...hook, scope };
}

beforeEach(() => { api.upload.mockReset(); api.preview.mockReset(); });
afterEach(cleanup);

test("选择文件后立即出现准备状态，异步乱序完成仍按选择顺序保留成功文件", async () => {
    const first = deferred<ReturnType<typeof media>>();
    const second = deferred<ReturnType<typeof media>>();
    api.upload.mockImplementation((_blob, name) => name === "一.png" ? first.promise : second.promise);
    const { result } = mount();
    act(() => result.current.addFiles([file("一.png"), file("二.png")]));
    expect(result.current.uploads.map((item) => item.status)).toEqual(["preparing", "preparing"]);
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(media("second")));
    expect(result.current.references).toHaveLength(0);
    expect(result.current.hasPending()).toBe(true);
    await act(async () => first.resolve(media("first")));
    expect(result.current.references.map((item) => item.name)).toEqual(["一.png", "二.png"]);
    expect(result.current.uploads).toHaveLength(0);
});

test("一项失败不会吞掉其他成功项，重试只处理失败文件", async () => {
    api.upload.mockImplementation((_blob, name) => name === "失败.png" ? Promise.reject(new Error("上传连接中断")) : Promise.resolve(media("success")));
    const { result } = mount();
    act(() => result.current.addFiles([file("失败.png"), file("成功.png")]));
    await waitFor(() => expect(result.current.references).toHaveLength(1));
    expect(result.current.references[0].name).toBe("成功.png");
    expect(result.current.uploads[0]).toMatchObject({ status: "failed", error: "上传连接中断", retryable: true });
    expect(result.current.hasFailures()).toBe(true);
    api.upload.mockResolvedValue(media("retried"));
    act(() => result.current.retry(result.current.uploads[0].id));
    await waitFor(() => expect(result.current.references).toHaveLength(2));
    expect(api.upload).toHaveBeenCalledTimes(3);
    expect(result.current.hasFailures()).toBe(false);
});

test("连续并发选择文件和素材库插入共用九个名额，超量会明示且不会发起上传", async () => {
    const pending = deferred<ReturnType<typeof media>>();
    api.upload.mockReturnValue(pending.promise);
    const { result } = mount(Array.from({ length: 7 }, (_, index) => reference(String(index))), 9);
    act(() => {
        result.current.addFiles([file("一.png"), file("二.png")]);
        result.current.addFiles([file("三.png")]);
        result.current.addReference(reference("素材库图片"));
    });
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(2));
    expect(result.current.uploads.filter((item) => item.status === "failed")).toHaveLength(2);
    expect(result.current.uploads.find((item) => item.name === "三.png")?.error).toContain("最多添加 9 个");
    await act(async () => pending.resolve(media("done")));
    expect(result.current.references).toHaveLength(9);
    const rejected = result.current.uploads.find((item) => item.name === "三.png")!;
    act(() => result.current.retry(rejected.id));
    expect(api.upload).toHaveBeenCalledTimes(2);
    act(() => result.current.setReferences((items) => items.slice(1)));
    api.upload.mockResolvedValue(media("last"));
    act(() => result.current.retry(rejected.id));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.references).toHaveLength(9));
});

test("不支持的文件明示原因且可移除，不上传也不支持无效重试", () => {
    const { result } = mount();
    act(() => result.current.addFiles([file("说明.txt", "text/plain")]));
    const rejected = result.current.uploads[0];
    expect(rejected).toMatchObject({ status: "failed", error: "仅支持图片文件", retryable: false });
    act(() => result.current.retry(rejected.id));
    expect(api.upload).not.toHaveBeenCalled();
    act(() => result.current.remove(rejected.id));
    expect(result.current.uploads).toHaveLength(0);
});

test("移除上传中的文件后，迟到成功不会追加到参考列表", async () => {
    const pending = deferred<ReturnType<typeof media>>();
    api.upload.mockReturnValue(pending.promise);
    const { result } = mount();
    act(() => result.current.addFiles([file("已移除.png")]));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    act(() => result.current.remove(result.current.uploads[0].id));
    await act(async () => pending.resolve(media("removed")));
    expect(result.current.references).toHaveLength(0);
});

test.each(["切换批次", "新草稿", "清空输入"])("%s 后旧上传不写入新的输入", async () => {
    const pending = deferred<ReturnType<typeof media>>();
    api.upload.mockReturnValue(pending.promise);
    const { result, scope } = mount();
    act(() => result.current.addFiles([file("旧文件.png")]));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    act(() => { scope.input++; result.current.setReferences([reference("新的输入")]); });
    await act(async () => pending.resolve(media("old")));
    expect(result.current.references.map((item) => item.id)).toEqual(["新的输入"]);
    expect(result.current.uploads).toHaveLength(0);
});

test("剪贴板读取开始前捕获输入版本，换批次后不读取图片内容或发起上传", async () => {
    const pending = deferred<ClipboardItem[]>();
    const getType = vi.fn().mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read: () => pending.promise } });
    const { result, scope } = mount();
    act(() => { void result.current.addClipboard(); });
    expect(result.current.uploads[0].status).toBe("preparing");
    act(() => { scope.input++; result.current.clearUploads(); });
    await act(async () => pending.resolve([{ types: ["image/png"], getType } as unknown as ClipboardItem]));
    expect(getType).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
});

test("剪贴板尚在读取时选择的文件不会抢到前面，完成后按添加顺序呈现", async () => {
    const pending = deferred<ClipboardItem[]>();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read: () => pending.promise } });
    api.upload.mockImplementation((_blob, name) => Promise.resolve(media(name)));
    const { result } = mount();
    act(() => { void result.current.addClipboard(); result.current.addFiles([file("稍后选择.png")]); });
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    expect(result.current.references).toHaveLength(0);
    await act(async () => pending.resolve([{ types: ["image/png"], getType: async () => new Blob(["image"], { type: "image/png" }) } as unknown as ClipboardItem]));
    await waitFor(() => expect(result.current.references).toHaveLength(2));
    expect(result.current.references.map((item) => item.name)).toEqual(["剪贴板图片-1.png", "稍后选择.png"]);
});

test("剪贴板不支持的格式不会阻塞随后已上传的文件", async () => {
    const pending = deferred<ClipboardItem[]>();
    const getType = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read: () => pending.promise } });
    api.upload.mockResolvedValue(media("ready"));
    const { result } = mount();
    act(() => { void result.current.addClipboard(); result.current.addFiles([file("正常图片.png")]); });
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    await act(async () => pending.resolve([{ types: ["image/gif"], getType } as unknown as ClipboardItem]));
    await waitFor(() => expect(result.current.references).toHaveLength(1));
    expect(result.current.references[0].name).toBe("正常图片.png");
    expect(result.current.hasPending()).toBe(false);
    expect(result.current.uploads[0].status).toBe("failed");
    expect(getType).not.toHaveBeenCalled();
});

test("图片准备期间切换登录会话，完成后不发请求或写回旧素材", async () => {
    const pending = deferred<Blob>();
    const { result, scope, rerender } = mount([reference("旧账号")]);
    act(() => result.current.addSources([{ name: "准备中的图片", type: "image/png", prepare: () => pending.promise }]));
    scope.session++;
    rerender({ sessionVersion: 2 });
    await act(async () => pending.resolve(new Blob(["old"], { type: "image/png" })));
    expect(api.upload).not.toHaveBeenCalled();
    expect(result.current.references).toHaveLength(0);
    expect(result.current.uploads).toHaveLength(0);
});
