import { expect, test, vi } from "vitest";
const media = vi.hoisted(() => ({ meta: vi.fn(), upload: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ uploadImage: media.upload }));
vi.mock("@/lib/image-utils", () => ({ readImageMeta: media.meta }));
vi.mock("@/constant/canvas", () => ({ NODE_DEFAULT_SIZE: {}, getNodeSpec: () => ({ width: 340, height: 240, title: "节点" }) }));
import { prepareCanvasHandoff } from "@/lib/canvas/canvas-handoff";

test("已有媒体直接引用，准备完毕后批量排列并保留原始比例", async () => {
    media.meta.mockResolvedValue({ width: 1200, height: 800 });
    const nodes = await prepareCanvasHandoff([{ kind: "image", title: "图片", dataUrl: "/api/media/image", storageKey: "image" }, { kind: "text", title: "文案", content: "保留这段文字" }], { x: 0, y: 0 }, () => {});
    expect(media.upload).not.toHaveBeenCalled();
    expect(nodes[0].width / nodes[0].height).toBe(1.5);
    expect(nodes[0].metadata).toMatchObject({ storageKey: "image", naturalWidth: 1200, naturalHeight: 800 });
    expect(nodes[1].metadata.content).toBe("保留这段文字");
    expect(nodes[0].position.x + nodes[0].width).toBeLessThanOrEqual(nodes[1].position.x);
});

test("素材异步准备期间切走时拒绝整批结果，不返回部分节点", async () => {
    let resolve!: (value: { width: number; height: number }) => void;
    media.meta.mockReturnValue(new Promise((done) => { resolve = done; }));
    let current = true;
    const preparation = prepareCanvasHandoff([{ kind: "image", title: "图片", dataUrl: "/api/media/image", storageKey: "image" }, { kind: "text", title: "文案", content: "内容" }], { x: 0, y: 0 }, () => { if (!current) throw new DOMException("已切走", "AbortError"); });
    current = false;
    resolve({ width: 100, height: 100 });
    await expect(preparation).rejects.toThrow("已切走");
});
