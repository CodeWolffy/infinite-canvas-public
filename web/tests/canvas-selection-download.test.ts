import { beforeEach, expect, test, vi } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const api = vi.hoisted(() => ({ image: vi.fn(), media: vi.fn(), zip: vi.fn(), save: vi.fn(), session: 1 }));
vi.mock("file-saver", () => ({ saveAs: api.save }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/zip", () => ({ createZip: api.zip }));
vi.mock("@/services/image-storage", () => ({ getImageBlob: api.image }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: api.media }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => ({ sessionVersion: api.session }) },
    assertCurrentSession: (version: number) => { if (version !== api.session) throw new DOMException("登录会话已变化", "AbortError"); },
}));
import { exportCanvasNodes } from "@/lib/canvas/canvas-export";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 120, height: 80, metadata });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { api.session = 1; api.image.mockReset(); api.media.mockReset(); api.save.mockReset(); api.zip.mockReset().mockResolvedValue(new Blob(["zip"])); vi.unstubAllGlobals(); });

test("选中内容按原格式打包，媒体字节保持原样，重名文件不互相覆盖", async () => {
    const image = new Blob(["original-image-bytes"], { type: "image/png" });
    const video = new Blob(["original-video-bytes"], { type: "video/mp4" });
    api.image.mockResolvedValue(image);
    api.media.mockResolvedValue(video);
    const imageNode = node("图片", CanvasNodeType.Image, { storageKey: "image:first", naturalWidth: 4000, naturalHeight: 1000 });
    await exportCanvasNodes([imageNode, { ...node("另一张", CanvasNodeType.Image, { storageKey: "image:second" }), title: "图片" }, node("视频", CanvasNodeType.Video, { storageKey: "media:video" }), node("文案", CanvasNodeType.Text, { content: "完整文本" }), node("配置", CanvasNodeType.Config)], "选中内容");
    const entries = api.zip.mock.calls[0][0] as { name: string; data: BlobPart }[];
    expect(entries.map((entry) => entry.name).sort()).toEqual(["图片-1.png", "图片.png", "文案.txt", "视频.mp4", "配置.json"].sort());
    expect(entries.find((entry) => entry.name === "图片.png")?.data).toBe(image);
    expect(entries.find((entry) => entry.name === "视频.mp4")?.data).toBe(video);
    expect(entries.find((entry) => entry.name === "文案.txt")?.data).toBe("完整文本");
    expect(imageNode.metadata).toMatchObject({ naturalWidth: 4000, naturalHeight: 1000 });
    expect(api.save).toHaveBeenCalledWith(expect.any(Blob), "选中内容.zip");
});

test("读取媒体期间切换账号，迟到数据不打包也不下载", async () => {
    const pending = deferred<Blob>();
    api.image.mockReturnValue(pending.promise);
    const result = exportCanvasNodes([node("图片", CanvasNodeType.Image, { storageKey: "image:first" })]);
    api.session++;
    pending.resolve(new Blob(["private-image"]));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(api.zip).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
});

test("读取 data URL 响应后切换账号，不继续读取 Blob 正文", async () => {
    const response = deferred<Response>();
    const blob = vi.fn().mockResolvedValue(new Blob(["image"]));
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(response.promise));
    const result = exportCanvasNodes([node("插件图片", CanvasNodeType.Image, { content: "data:image/png;base64,AA==" })]);
    api.session++;
    response.resolve({ blob } as unknown as Response);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(blob).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
});

test("ZIP 完成前切换账号，最终下载也会阻止", async () => {
    const pending = deferred<Blob>();
    api.zip.mockReturnValue(pending.promise);
    const result = exportCanvasNodes([node("文案", CanvasNodeType.Text, { content: "私有文本" })]);
    await vi.waitFor(() => expect(api.zip).toHaveBeenCalledOnce());
    api.session++;
    pending.resolve(new Blob(["private-zip"]));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(api.save).not.toHaveBeenCalled();
});

test("任一素材读取失败不下载残缺压缩包", async () => {
    api.image.mockRejectedValue(new Error("文件无权访问"));
    await expect(exportCanvasNodes([node("图片", CanvasNodeType.Image, { storageKey: "image:first" }), node("文案", CanvasNodeType.Text, { content: "文本" })])).rejects.toThrow("文件无权访问");
    expect(api.zip).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
});
