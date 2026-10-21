import { expect, test, vi } from "vitest";

vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => ({ sessionVersion: 1, user: { id: "test" } }), subscribe: () => () => undefined },
    assertCurrentSession: vi.fn(),
}));

const { defaultConfig } = await import("@/stores/use-config-store");
const { platformImageParameters } = await import("@/services/api/image");
const { videoGenerationParameters, pollVideoGenerationTask } = await import("@/services/api/video");
const { selectedPlatformModel } = await import("@/services/api/tasks");
const { buildGenerationConfig } = await import("@/lib/canvas/canvas-generation-helpers");

test("图像质量不会改变比例或明确选择的分辨率", () => {
    for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) {
        expect(platformImageParameters({ ...defaultConfig, quality, size: "16:9" }).size).toBe("1536x864");
        expect(platformImageParameters({ ...defaultConfig, quality, size: "3840x2160" })).toMatchObject({ size: "3840x2160", resolution: "4k" });
    }
    expect(platformImageParameters({ ...defaultConfig, quality: "max", size: "auto" })).toEqual({ resolution: "auto", quality: "max" });
    expect(platformImageParameters({ ...defaultConfig, quality: "low", size: "1024x1536" }).resolution).toBe("1k");
});

test("视频参数同时携带尺寸和宽高比，自动比例不强制提交 ratio", () => {
    expect(videoGenerationParameters({ ...defaultConfig, size: "9:16", vquality: "1080" })).toMatchObject({ size: "1080x1920", ratio: "9:16", resolution_name: "1080" });
    expect(videoGenerationParameters({ ...defaultConfig, size: "1280x720" }).ratio).toBe("16:9");
    expect(videoGenerationParameters({ ...defaultConfig, size: "auto" })).not.toHaveProperty("ratio");
});

test("画布默认视频分辨率不沿用生图像素尺寸，节点自己的尺寸优先", () => {
    const config = { ...defaultConfig, size: "3840x2160", vquality: "1080" };
    expect(buildGenerationConfig(config, undefined, "video").size).toBe("1920x1080");
    const node = { id: "video", type: "video", title: "video", position: { x: 0, y: 0 }, width: 420, height: 236, metadata: { size: "1280x720", vquality: "720" } };
    expect(buildGenerationConfig(config, node, "video").size).toBe("1280x720");
});

test("失效或类型错误的模型不能静默换成列表中的其它模型", () => {
    const models = [{ id: "available", name: "available", displayName: "可用模型", capability: "video" as const, sortOrder: 0, description: null }];
    expect(selectedPlatformModel(models, "platform::available", "video")).toBe("available");
    expect(() => selectedPlatformModel(models, "platform::removed", "video")).toThrow("所选模型已不可用");
    expect(() => selectedPlatformModel(models, "available", "image")).toThrow("所选模型已不可用");
});

test("已提交的视频按平台任务 ID 读取结果，不因可选模型下线而换渠道或丢失结果", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ task: { id: "accepted-task", status: "succeeded", output: { mediaId: "media", url: "/api/media/media", mimeType: "video/mp4", bytes: 1 } } }), { status: 200 }));
    try {
        const result = await pollVideoGenerationTask(defaultConfig, { id: "accepted-task", provider: "platform", model: "removed" });
        expect(fetch.mock.calls[0][0]).toBe("/api/generation-tasks/accepted-task");
        expect(result).toMatchObject({ status: "completed", result: { url: "/api/media/media" } });
    } finally {
        fetch.mockRestore();
    }
});
