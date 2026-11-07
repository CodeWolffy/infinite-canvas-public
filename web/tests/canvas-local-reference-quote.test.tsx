import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { CanvasGenerationMode, CanvasNodeData } from "@/types/canvas";

const state = vi.hoisted(() => ({ sessionVersion: 1, projectId: "project-a", upload: vi.fn(), quote: vi.fn() }));
vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ id: state.projectId }) }));
vi.mock("@/services/api/tasks", () => ({ ensurePlatformMedia: state.upload }));
vi.mock("@/services/api/platform-operations", () => ({ quoteGeneration: state.quote }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state, subscribe: () => () => undefined }),
    assertCurrentSession: (version: number) => { if (state.sessionVersion !== version) throw new DOMException("会话已变更", "AbortError"); },
}));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
const { useCanvasGenerationQuote } = await import("@/components/canvas/use-canvas-generation-quote");
const { prepareCanvasNodeGeneration, canvasGenerationInputKey } = await import("@/components/canvas/canvas-generation-preparation");
const { defaultConfig } = await import("@/stores/use-config-store");
const { registerNodeDefinitions } = await import("@/lib/canvas/node-registry");
const { initI18n } = await import("@/i18n");
const mediaId = "11111111-1111-1111-1111-111111111111";
const config = { ...defaultConfig, imageModel: "platform::image", textModel: "platform::text", videoModel: "platform::video", platformModels: (["image", "text", "video"] as const).map((capability) => ({ name: capability, capability })) };
const target: CanvasNodeData = { id: "target", type: "config", title: "配置", width: 340, height: 240, position: { x: 0, y: 0 } };
const panorama: CanvasNodeData = { ...target, id: "panorama", type: "panorama:quote-test", metadata: { content: "data:image/png;base64,YQ==" } };
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const useQuote = (prompt: string, mode: CanvasGenerationMode = "image", second = false) => {
    const nodes = [target, panorama, ...(second ? [{ ...panorama, id: "second" }] : [])];
    const prepared = prepareCanvasNodeGeneration(config, target, nodes, nodes.slice(1).map((node) => ({ id: node.id, fromNodeId: node.id, toNodeId: target.id })), mode, prompt);
    return useCanvasGenerationQuote(target, mode, prompt, prepared, false, false);
};
beforeAll(async () => {
    await initI18n();
    registerNodeDefinitions([{ type: panorama.type, title: "全景", icon: null, defaultSize: { width: 480, height: 300 }, resource: (node) => ({ kind: "image", url: node.metadata?.content || "" }) }]);
});
beforeEach(() => {
    state.sessionVersion = 1;
    state.projectId = "project-a";
    state.upload.mockReset().mockResolvedValue(mediaId);
    state.quote.mockReset().mockResolvedValue({ quote: { estimatedHold: "0.4" } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });

test.each(["image", "text", "video"] as const)("%s 使用全景插件 dataURL 时仅点击准备才上传，报价后使用同一已保存引用提交", async (mode) => {
    const hook = renderHook(() => useQuote("参考全景创作", mode), { wrapper });
    expect(hook.result.current.needsPreparation).toBe(true);
    expect(hook.result.current.canGenerate).toBe(false);
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.quote).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.prepareMedia(); });
    await waitFor(() => expect(hook.result.current.canGenerate).toBe(true));
    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.upload.mock.calls[0][0].dataUrl).toBe(panorama.metadata?.content);
    expect(state.quote.mock.calls[0][0].attachmentMediaIds).toEqual([mediaId]);
    const media = hook.result.current.preparedMedia!;
    expect(media).toMatchObject({ projectId: "project-a", sessionVersion: 1, references: { referenceImages: [{ dataUrl: `/api/media/${mediaId}`, storageKey: `media:${mediaId}` }] } });
    const prepared = prepareCanvasNodeGeneration(config, target, [target, panorama], [{ id: panorama.id, fromNodeId: panorama.id, toNodeId: target.id }], mode, "参考全景创作");
    expect(media.inputKey).toBe(canvasGenerationInputKey(target, mode, prepared));
});

test.each(["prompt", "project", "session"] as const)("准备中切换 %s 后旧结果不能报价、继续准备其他引用或覆盖输入", async (kind) => {
    let finish!: (id: string) => void;
    state.upload.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const hook = renderHook(({ prompt }) => useQuote(prompt, "image", true), { initialProps: { prompt: "旧内容" }, wrapper });
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.prepareMedia(); });
    await waitFor(() => expect(state.upload).toHaveBeenCalledOnce());
    if (kind === "project") state.projectId = "project-b";
    if (kind === "session") state.sessionVersion++;
    hook.rerender({ prompt: kind === "prompt" ? "新内容" : "旧内容" });
    expect(state.upload.mock.calls[0][1].aborted).toBe(true);
    await act(async () => { finish(mediaId); await pending; });
    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.quote).not.toHaveBeenCalled();
    expect(hook.result.current.preparedMedia).toBeUndefined();
    expect(hook.result.current.needsPreparation).toBe(true);
    expect(hook.result.current.canGenerate).toBe(false);
});

test("复制图片节点重复引用同一平台图片时保持两处提示词引用，只向报价传一份媒体 ID", async () => {
    const first = { ...panorama, type: "image", metadata: { content: `/api/media/${mediaId}`, storageKey: `image:${mediaId}` } };
    const second = { ...first, id: "copy" };
    const nodes = [target, first, second];
    const prepared = prepareCanvasNodeGeneration(config, target, nodes, nodes.slice(1).map((node) => ({ id: node.id, fromNodeId: node.id, toNodeId: target.id })), "image", "结合图1和图2");
    const hook = renderHook(() => useCanvasGenerationQuote(target, "image", "结合图1和图2", prepared, false, false), { wrapper });
    await waitFor(() => expect(hook.result.current.canGenerate).toBe(true));
    expect(prepared.context.referenceImages).toHaveLength(2);
    expect(state.quote.mock.calls[0][0].attachmentMediaIds).toEqual([mediaId]);
    expect(state.quote.mock.calls[0][0].content).toContain("结合图1和图2");
    expect(state.upload).not.toHaveBeenCalled();
});
