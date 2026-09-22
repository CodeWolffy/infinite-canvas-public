import { beforeEach, expect, test, vi } from "vitest";

// 平台模型由 /api/models 下发，这里只替换数据源，其余逻辑用真实实现。
const state = vi.hoisted(() => ({ models: [] as unknown[] }));

vi.mock("@/services/api/models", () => ({
    listModels: async () => state.models,
}));

vi.mock("@/stores/use-user-store", () => ({
    useUserStore: {
        getState: () => ({ sessionVersion: 1, user: { id: "user-1" } }),
        subscribe: () => () => undefined,
        persist: undefined,
    },
}));

const { useConfigStore, defaultConfig, hasPlatformModel, selectableModelsByCapability, normalizeModelOptionValue, modelOptionLabel } = await import("@/stores/use-config-store");

const model = (id: string, capability: string, displayName: string) => ({ id, name: id, displayName, capability, sortOrder: 0, description: null });

beforeEach(() => {
    state.models = [];
    useConfigStore.setState({ config: { ...defaultConfig, platformModels: [] } });
});

test("hydratePlatformModels 用平台模型填充可选列表与默认模型", async () => {
    state.models = [model("img-1", "image", "图像模型"), model("txt-1", "text", "文本模型"), model("vid-1", "video", "视频模型")];
    await useConfigStore.getState().hydratePlatformModels();
    const config = useConfigStore.getState().config;
    expect(config.platformModels.map((item) => item.name)).toEqual(["img-1", "txt-1", "vid-1"]);
    // 模型值保持 platform::<uuid> 编码，画布快照里已保存这种格式。
    expect(config.imageModel).toBe("platform::img-1");
    expect(config.textModel).toBe("platform::txt-1");
    expect(config.videoModel).toBe("platform::vid-1");
    expect(config.model).toBe("platform::img-1");
    expect(config.audioModel).toBe("");
    expect(selectableModelsByCapability(config, "text")).toEqual(["platform::txt-1"]);
    expect(modelOptionLabel(config, "platform::img-1")).toBe("图像模型");
});

test("hasPlatformModel 只认当前仍发布的模型", async () => {
    state.models = [model("img-1", "image", "图像模型")];
    await useConfigStore.getState().hydratePlatformModels();
    const config = useConfigStore.getState().config;
    expect(hasPlatformModel(config, "platform::img-1")).toBe(true);
    expect(hasPlatformModel(config, "platform::gone")).toBe(false);
    expect(hasPlatformModel(config, "")).toBe(false);
    // 平台下线后同一编码立即失效。
    useConfigStore.setState({ config: { ...config, platformModels: [] } });
    expect(hasPlatformModel(useConfigStore.getState().config, "platform::img-1")).toBe(false);
});

test("normalizeModelOptionValue 只接受平台已发布的模型", async () => {
    state.models = [model("img-1", "image", "图像模型")];
    await useConfigStore.getState().hydratePlatformModels();
    const config = useConfigStore.getState().config;
    expect(normalizeModelOptionValue("img-1", config.platformModels)).toBe("platform::img-1");
    expect(normalizeModelOptionValue("图像模型", config.platformModels)).toBe("platform::img-1");
    expect(normalizeModelOptionValue("unknown", config.platformModels)).toBe("");
    expect(normalizeModelOptionValue(undefined, config.platformModels)).toBe("");
});
