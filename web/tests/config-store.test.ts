import { beforeEach, expect, test, vi } from "vitest";

// 平台模型由 /api/models 下发，这里只替换数据源，其余逻辑用真实实现。
const state = vi.hoisted(() => ({ models: [] as unknown[], preferences: {} as Record<string, unknown>, sessionVersion: 1 }));

vi.mock("@/hooks/use-public-models", () => ({
    fetchPublicModels: async () => state.models,
}));

vi.mock("@/services/api/generation", () => ({
    getGenerationPreferences: vi.fn(async () => state.preferences),
}));

vi.mock("@/stores/use-user-store", () => ({
    useUserStore: {
        getState: () => ({ sessionVersion: state.sessionVersion, user: { id: "user-1" } }),
        subscribe: () => () => undefined,
        persist: undefined,
    },
    assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new DOMException("登录会话已变更", "AbortError"); },
}));

const { useConfigStore, defaultConfig, hasPlatformModel, selectableModelsByCapability, normalizeModelOptionValue, modelOptionLabel, resolveModelForCapability } = await import("@/stores/use-config-store");
const { getGenerationPreferences } = await import("@/services/api/generation");

const model = (id: string, capability: string, displayName: string) => ({ id, name: id, displayName, capability, sortOrder: 0, description: null });

beforeEach(() => {
    state.models = [];
    state.preferences = {};
    state.sessionVersion = 1;
    vi.mocked(getGenerationPreferences).mockClear();
    useConfigStore.setState({ config: { ...defaultConfig, platformModels: [] } });
});

test("模型刷新后保留失效选择，只有明确切换能力时才选择对应默认模型", async () => {
    state.models = [model("img-1", "image", "图像模型"), model("vid-1", "video", "视频模型")];
    useConfigStore.setState({ config: { ...defaultConfig, imageModel: "platform::removed" } });
    await useConfigStore.getState().hydratePlatformModels();
    const config = useConfigStore.getState().config;
    expect(config.imageModel).toBe("platform::removed");
    expect(resolveModelForCapability(config, "platform::removed", "image")).toBe("platform::removed");
    expect(hasPlatformModel(config, config.imageModel)).toBe(false);
    expect(resolveModelForCapability(config, "platform::img-1", "video")).toBe("platform::vid-1");
    for (const capability of ["image", "video", "text", "audio"] as const) {
        expect(resolveModelForCapability(config, "platform::removed", capability)).toBe("platform::removed");
    }
});

test("并发初始化共用偏好请求，工作台参数在默认值载入后应用", async () => {
    state.preferences = { size: "2048x2048", vquality: "1080", nodeRegenerateBehavior: "overwrite", autoFocusOnSelect: true };
    const first = useConfigStore.getState().hydratePreferences();
    const second = useConfigStore.getState().hydratePreferences();
    expect(first).toBe(second);
    expect(await first).toEqual(state.preferences);
    expect(getGenerationPreferences).toHaveBeenCalledTimes(1);
    expect(useConfigStore.getState().config).toMatchObject(state.preferences);
    useConfigStore.getState().updateConfig("size", "1920x1080");
    await second;
    expect(useConfigStore.getState().config.size).toBe("1920x1080");
});

test("切换会话后旧偏好响应不得写回", async () => {
    state.preferences = { nodeRegenerateBehavior: "overwrite", autoFocusOnSelect: true };
    const pending = useConfigStore.getState().hydratePreferences();
    state.sessionVersion++;
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(useConfigStore.getState().config.nodeRegenerateBehavior).toBe("new-node");
    expect(useConfigStore.getState().config.autoFocusOnSelect).toBe(false);
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
