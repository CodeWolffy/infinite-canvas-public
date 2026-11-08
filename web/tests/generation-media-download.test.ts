import { afterEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ session: 1 }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => ({ sessionVersion: state.session }), subscribe: () => () => {} },
    assertCurrentSession: (session: number) => { if (session !== state.session) throw new DOMException("登录会话已变化", "AbortError"); },
}));
const { readGenerationImage, listGenerationBatches } = await import("@/services/api/generation");
afterEach(() => { state.session = 1; vi.unstubAllGlobals(); });
const response = (blob: Blob, status = 200) => ({ ok: status === 200, status, blob: async () => blob });

test("图片下载检查HTTP、真实媒体解码，并使用实际图片扩展名", async () => {
    const close = vi.fn();
    const fetch = vi.fn().mockResolvedValue(response(new Blob(["image"], { type: "image/jpeg" })));
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 10, height: 10, close }));
    expect((await readGenerationImage("media-id")).extension).toBe("jpg");
    expect(fetch).toHaveBeenCalledWith("/api/media/media-id", { credentials: "include", cache: "no-cache" });
    expect(close).toHaveBeenCalledOnce();
    fetch.mockResolvedValue(response(new Blob(["error"], { type: "text/html" }), 404));
    await expect(readGenerationImage("media-id")).rejects.toThrow("HTTP 404");
});

test("拒绝HTML、空文件和伪装为图片的损坏内容", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode failed")));
    for (const blob of [new Blob(["html"], { type: "text/html" }), new Blob([], { type: "image/png" })]) {
        fetch.mockResolvedValue(response(blob)); await expect(readGenerationImage("id")).rejects.toThrow("不是有效图片");
    }
    fetch.mockResolvedValue(response(new Blob(["not a png"], { type: "image/png" })));
    await expect(readGenerationImage("id")).rejects.toThrow("无法解码");
});

test("图片解码期间切换账号拒绝返回旧媒体", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(new Blob(["image"], { type: "image/png" }))));
    vi.stubGlobal("createImageBitmap", vi.fn().mockImplementation(async () => { state.session++; return { width: 10, height: 10, close: vi.fn() }; }));
    await expect(readGenerationImage("id")).rejects.toMatchObject({ name: "AbortError" });
});

test("生成历史将关键词交给服务端并保持分页参数", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ batches: [] }) }); vi.stubGlobal("fetch", fetch);
    await listGenerationBatches(50, 100, " older image ");
    const url = new URL(fetch.mock.calls[0][0], "https://example.test");
    expect(Object.fromEntries(url.searchParams)).toEqual({ capability: "image", limit: "50", offset: "100", q: "older image" });
});
