import { create } from "zustand";
import { persist } from "zustand/middleware";

import { modelPriceLabel, type ModelPricing } from "@/lib/model-price";
import type { ModelReasoning, ReasoningEffort } from "@/lib/model-reasoning";
import { getGenerationPreferences, type PublicModel } from "@/services/api/generation";
import { fetchPublicModels } from "@/hooks/use-public-models";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type ModelCapability = "image" | "video" | "text" | "audio";
export type { ReasoningEffort } from "@/lib/model-reasoning";

export type ChannelModel = ModelPricing & ModelReasoning & {
    name: string;
    capability: ModelCapability;
    displayName?: string;
    modelName?: string;
    description?: string | null;
};

export type AiConfig = {
    /** 平台已发布的模型，`name` 为模型 UUID；由后端 /api/models 下发，不在本地持久化。 */
    platformModels: ChannelModel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    nodeRegenerateBehavior: "new-node" | "overwrite";
    autoFocusOnSelect: boolean;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const PLATFORM_CHANNEL_ID = "platform";
let pendingPreferences: { sessionVersion: number; promise: Promise<Record<string, unknown>> } | null = null;

export const defaultConfig: AiConfig = {
    platformModels: [],
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: [],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
    nodeRegenerateBehavior: "new-node",
    autoFocusOnSelect: false,
};

type ConfigStore = {
    config: AiConfig;
    hydratePlatformModels: () => Promise<void>;
    hydratePreferences: () => Promise<Record<string, unknown>>;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
};

export function boolConfig(value: unknown, fallback: boolean) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value ? value === "true" : fallback;
    return fallback;
}

function findPlatformModel(config: AiConfig, value: string): ChannelModel | null {
    const name = modelOptionName(value);
    return config.platformModels.find((model) => model.name === name || model.displayName === name) || null;
}

export function findChannelModel(config: AiConfig, value: string): { model: ChannelModel } | null {
    const model = findPlatformModel(config, value);
    return model ? { model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findPlatformModel(config, value)?.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return "";
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.platformModels.filter((model) => model.capability === capability).map((model) => encodeChannelModel(PLATFORM_CHANNEL_ID, model.name));
}

/** 画布与工作台用它判断模型是否仍由平台发布；平台已下线的模型会返回 false。 */
export function hasPlatformModel(config: AiConfig, model: string): boolean {
    return Boolean(model.trim()) && Boolean(findPlatformModel(config, model));
}

function platformConfig(config: AiConfig, models: PublicModel[]): AiConfig {
    // Platform models are selected by UUID. Their public identifiers may be
    // shared by variants (for example, standard and 4K models routing to the
    // same upstream model), while the display name remains user-facing.
    const platformModels: ChannelModel[] = models.map((model) => ({ ...model, name: model.id, modelName: model.name }));
    const firstOf = (capability: ModelCapability) => platformModels.find((model) => model.capability === capability);
    const valueOf = (model?: ChannelModel) => (model ? encodeChannelModel(PLATFORM_CHANNEL_ID, model.name) : "");
    const imageModel = config.imageModel || valueOf(firstOf("image"));
    const textModel = config.textModel || valueOf(firstOf("text"));
    return {
        ...config,
        platformModels,
        models: platformModels.map((model) => encodeChannelModel(PLATFORM_CHANNEL_ID, model.name)),
        model: config.model || imageModel || textModel,
        imageModel,
        textModel,
        videoModel: config.videoModel || valueOf(firstOf("video")),
        audioModel: config.audioModel || valueOf(firstOf("audio")),
    };
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set) => ({
            config: defaultConfig,
            hydratePlatformModels: async () => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                const models = await fetchPublicModels();
                if (useUserStore.getState().sessionVersion !== sessionVersion) return;
                set((state) => ({ config: platformConfig(state.config, models) }));
            },
            hydratePreferences: () => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                if (pendingPreferences?.sessionVersion === sessionVersion) return pendingPreferences.promise;
                const promise = getGenerationPreferences().then((preferences) => {
                    assertCurrentSession(sessionVersion);
                    set((state) => {
                        const config = { ...state.config };
                        for (const key of ["size", "vquality", "canvasImageCount"] as const) {
                            if (typeof preferences[key] === "string") config[key] = preferences[key];
                        }
                        if (typeof preferences.imageModelId === "string" && preferences.imageModelId) config.imageModel = preferences.imageModelId;
                        if (typeof preferences.videoModelId === "string" && preferences.videoModelId) config.videoModel = preferences.videoModelId;
                        config.nodeRegenerateBehavior = preferences.nodeRegenerateBehavior === "overwrite" ? "overwrite" : "new-node";
                        config.autoFocusOnSelect = preferences.autoFocusOnSelect === true;
                        return { config };
                    });
                    return preferences;
                }).finally(() => { if (pendingPreferences?.promise === promise) pendingPreferences = null; });
                pendingPreferences = { sessionVersion, promise };
                return promise;
            },
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
        }),
        {
            name: `${CONFIG_STORE_KEY}:${useUserStore.getState().user?.id || "anonymous"}`,
            partialize: (state) => ({
                config: {
                    quality: state.config.quality,
                    size: state.config.size,
                    background: state.config.background,
                    count: state.config.count,
                    canvasImageCount: state.config.canvasImageCount,
                    nodeRegenerateBehavior: state.config.nodeRegenerateBehavior,
                    autoFocusOnSelect: state.config.autoFocusOnSelect,
                    reasoningEffort: state.config.reasoningEffort,
                    systemPrompt: state.config.systemPrompt,
                    videoSeconds: state.config.videoSeconds,
                    vquality: state.config.vquality,
                    videoGenerateAudio: state.config.videoGenerateAudio,
                    videoWatermark: state.config.videoWatermark,
                    videoMode: state.config.videoMode,
                },
            }),
            merge: (persisted, current) => {
                const persistedConfig = ((persisted as Partial<ConfigStore> | null)?.config || {}) as Partial<AiConfig>;
                const defaults = defaultConfig;
                return {
                    ...current,
                    config: {
                        ...defaults,
                        quality: persistedConfig.quality ?? defaults.quality,
                        size: persistedConfig.size ?? defaults.size,
                        background: persistedConfig.background ?? defaults.background,
                        count: persistedConfig.count ?? defaults.count,
                        canvasImageCount: persistedConfig.canvasImageCount ?? defaults.canvasImageCount,
                        nodeRegenerateBehavior: persistedConfig.nodeRegenerateBehavior === "overwrite" ? "overwrite" : "new-node",
                        autoFocusOnSelect: persistedConfig.autoFocusOnSelect === true,
                        reasoningEffort: persistedConfig.reasoningEffort ?? defaults.reasoningEffort,
                        systemPrompt: persistedConfig.systemPrompt ?? defaults.systemPrompt,
                        videoSeconds: persistedConfig.videoSeconds ?? defaults.videoSeconds,
                        vquality: persistedConfig.vquality ?? defaults.vquality,
                        videoGenerateAudio: persistedConfig.videoGenerateAudio ?? defaults.videoGenerateAudio,
                        videoWatermark: persistedConfig.videoWatermark ?? defaults.videoWatermark,
                        videoMode: persistedConfig.videoMode ?? defaults.videoMode,
                    },
                };
            },
        },
    ),
);

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion === previous.sessionVersion) return;
    if (!useConfigStore.persist) {
        useConfigStore.setState({ config: defaultConfig });
        return;
    }
    useConfigStore.persist.setOptions({ name: `${CONFIG_STORE_KEY}:${state.user?.id || "anonymous"}` });
    void useConfigStore.persist.rehydrate();
});

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const model = findPlatformModel(config, value);
    return model ? model.displayName || model.name : modelOptionName(value);
}

export function modelOptionPrice(config: AiConfig, value: string): string | null {
    const model = findPlatformModel(config, value);
    return model ? modelPriceLabel(model) : null;
}

export function normalizeModelOptionValue(value: string | undefined, models: ChannelModel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const name = modelOptionName(model);
    const matched = models.find((item) => item.name === name || item.displayName === name);
    return matched ? encodeChannelModel(PLATFORM_CHANNEL_ID, matched.name) : "";
}
