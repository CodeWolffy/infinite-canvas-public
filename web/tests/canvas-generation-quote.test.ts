import { beforeAll, expect, test, vi } from "vitest";
import type { CanvasNodeData } from "@/types/canvas";

vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => ({ sessionVersion: 1, user: { id: "test" } }), subscribe: () => () => undefined },
    assertCurrentSession: vi.fn(),
}));

const { defaultConfig } = await import("@/stores/use-config-store");
const { initI18n } = await import("@/i18n");
const { prepareCanvasNodeGeneration } = await import("@/components/canvas/canvas-generation-preparation");
const { canvasNodeQuoteInput } = await import("@/components/canvas/use-canvas-generation-quote");
const { registerNodeDefinitions } = await import("@/lib/canvas/node-registry");
const { platformImageParameters, platformTextInput } = await import("@/services/api/image");
const { videoGenerationParameters } = await import("@/services/api/video");
const { audioGenerationParameters } = await import("@/services/api/audio");
beforeAll(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    await initI18n();
});

const config = {
    ...defaultConfig, imageModel: "platform::image", textModel: "platform::text", videoModel: "platform::video", audioModel: "platform::audio",
    platformModels: (["image", "text", "video", "audio"] as const).map((capability) => ({ name: capability, displayName: capability, capability, reasoningEfforts: ["high"] as const })),
};
const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];
const node = (id: string, type: string, metadata: CanvasNodeData["metadata"] = {}, y = 0): CanvasNodeData => ({ id, type, title: id, width: 340, height: 240, position: { x: 0, y }, metadata });
const image = (id: string, index: number, y = 0) => node(id, "image", { content: `/api/media/${ids[index]}`, storageKey: `image:${ids[index]}` }, y);
const connect = (fromNodeId: string, toNodeId: string) => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });

test("图片编辑报价按当前图、连接位置排序的参考图准备，并使用实际图片参数", () => {
    const current = { ...image("current", 0), metadata: { ...image("current", 0).metadata, count: 3, size: "16:9", quality: "high" } };
    const top = image("top", 1, 10);
    const bottom = image("bottom", 2, 100);
    const prepared = prepareCanvasNodeGeneration({ ...config, nodeRegenerateBehavior: "new-node" }, current, [current, bottom, top], [connect("bottom", "current"), connect("top", "current")], "image", "改变光线");
    const quote = canvasNodeQuoteInput(current, "image", prepared);
    expect(quote).toMatchObject({ modelId: "image", count: 3, attachmentMediaIds: ids, parameters: platformImageParameters(prepared.config) });
    expect(quote.content).toContain("改变光线");
    const overwrite = prepareCanvasNodeGeneration({ ...config, nodeRegenerateBehavior: "overwrite" }, current, [current, top], [connect("top", "current")], "image", "改变光线");
    expect(canvasNodeQuoteInput(current, "image", overwrite).attachmentMediaIds).toEqual([ids[1]]);
});

test("配置编排仅采用被引用素材，顺序跟随编排，文字内容合并进报价", () => {
    const current = node("config", "config", { composerContent: "结合 @[node:second] 和 @[node:first]，@[node:words]" });
    const nodes = [current, image("first", 0), image("second", 1), image("unused", 2), node("words", "text", { content: "保持暖色调" })];
    const prepared = prepareCanvasNodeGeneration(config, current, nodes, nodes.slice(1).map((item) => connect(item.id, current.id)), "image", current.metadata!.composerContent!);
    const quote = canvasNodeQuoteInput(current, "image", prepared);
    expect(quote.attachmentMediaIds).toEqual([ids[1], ids[0]]);
    expect(quote.content).toContain("保持暖色调");
    expect(quote.content).not.toContain("@[node:");
});

test("文本编辑报价包括原文、图片附件占位、系统提示词和当前对话；多份生成新对话", () => {
    const current = node("text", "text", { content: "原始段落", conversationId: "current-conversation", reasoningEffort: "high" });
    const prepared = prepareCanvasNodeGeneration({ ...config, systemPrompt: "保持简洁" }, current, [current, image("ref", 0)], [connect("ref", "text")], "text", "改成诗歌");
    const quote = canvasNodeQuoteInput(current, "text", prepared);
    expect(quote).toMatchObject({ modelId: "text", count: 1, conversationId: "current-conversation", attachmentMediaIds: [ids[0]], systemPrompt: "保持简洁", parameters: { reasoningEffort: "high" } });
    expect(quote.content).toContain("原始段落");
    expect(quote.content).toContain("改成诗歌");
    expect(quote.content).toContain("[图片附件]");
    const multiple = { ...current, metadata: { ...current.metadata, textCount: 3 } };
    const batch = canvasNodeQuoteInput(multiple, "text", prepareCanvasNodeGeneration(config, multiple, [multiple], [], "text", "改写"));
    expect(batch.count).toBe(1);
    expect(batch.conversationId).toBeUndefined();
});

test("音视频报价沿用真实参数，视频含有序媒体引用，音频仅使用朗读文本", () => {
    const current = node("config", "config", { seconds: "8", vquality: "1080", audioSpeed: "1.5", audioInstructions: "轻快" });
    const video = node("video", "video", { content: `/api/media/${ids[1]}`, storageKey: `media:${ids[1]}` });
    const audio = node("audio", "audio", { content: `/api/media/${ids[2]}`, storageKey: `media:${ids[2]}` });
    const nodes = [current, image("image", 0), video, audio];
    const connections = nodes.slice(1).map((item) => connect(item.id, current.id));
    const preparedVideo = prepareCanvasNodeGeneration(config, current, nodes, connections, "video", "制作短片");
    expect(canvasNodeQuoteInput(current, "video", preparedVideo)).toMatchObject({ count: 1, attachmentMediaIds: ids, parameters: videoGenerationParameters(preparedVideo.config) });
    const preparedAudio = prepareCanvasNodeGeneration(config, current, nodes, connections, "audio", "欢迎来到画布");
    expect(canvasNodeQuoteInput(current, "audio", preparedAudio)).toMatchObject({ count: 1, content: "欢迎来到画布", attachmentMediaIds: [], parameters: audioGenerationParameters(preparedAudio.config) });
});

test("引用未存储或模型失效时不产生漏项报价", () => {
    const current = node("config", "config");
    const unstored = node("unstored", "image", { content: "blob:local" });
    const prepared = prepareCanvasNodeGeneration(config, current, [current, unstored], [connect("unstored", "config")], "image", "编辑图片");
    expect(() => canvasNodeQuoteInput(current, "image", prepared)).toThrow("参考素材尚未保存");
    const unavailable = node("unavailable", "image", { model: "platform::removed" });
    expect(() => canvasNodeQuoteInput(unavailable, "image", prepareCanvasNodeGeneration(config, unavailable, [unavailable], [], "image", "画一棵树"))).toThrow("请选择可用模型");
});

test("引用的 URL 与存储键不同时，报价遵循各能力实际读取优先级", () => {
    const current = node("config", "config");
    const reference = node("reference", "image", { content: `/api/media/${ids[0]}`, storageKey: `image:${ids[1]}` });
    const nodes = [current, reference];
    const connections = [connect("reference", "config")];
    expect(canvasNodeQuoteInput(current, "image", prepareCanvasNodeGeneration(config, current, nodes, connections, "image", "编辑")).attachmentMediaIds).toEqual([ids[1]]);
    expect(canvasNodeQuoteInput(current, "text", prepareCanvasNodeGeneration(config, current, nodes, connections, "text", "描述")).attachmentMediaIds).toEqual([ids[0]]);
    const video = { ...reference, type: "video" };
    expect(canvasNodeQuoteInput(current, "video", prepareCanvasNodeGeneration(config, current, [current, video], connections, "video", "短片")).attachmentMediaIds).toEqual([ids[0]]);
});

test("插件写回单图沿用前缀与固定一张，文本 payload 对现有对话只采用末条输入", () => {
    registerNodeDefinitions([{ type: "quote-test-plugin", title: "全景", icon: null, defaultSize: { width: 340, height: 240 }, useBuiltinPanel: { mode: "image", writeBackToSelf: true, promptPrefix: "全景：" } }]);
    const current = node("plugin", "quote-test-plugin", { count: 4 });
    const prepared = prepareCanvasNodeGeneration(config, current, [current], [], "image", "森林");
    expect(canvasNodeQuoteInput(current, "image", prepared)).toMatchObject({ count: 1, content: "全景：森林" });
    expect(platformTextInput(config, [{ role: "system", content: "系统" }, { role: "user", content: "旧内容" }, { role: "user", content: "新内容" }], "existing")).toMatchObject({ content: "新内容", systemPrompt: [config.systemPrompt, "系统"].filter(Boolean).join("\n\n") });
});
