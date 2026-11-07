import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

const quote = vi.hoisted(() => ({ error: null as Error | null, ready: true, enabled: false, refetch: vi.fn() }));
vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/hooks/use-generation-quote", () => ({ useGenerationQuote: (_input: unknown, enabled: boolean) => { quote.enabled = enabled; return { error: quote.error, ready: quote.ready && !quote.error, quote: enabled && !quote.error ? { estimatedHold: "0.24" } : undefined, isFetching: false, refetch: quote.refetch }; } }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: Object.assign((select: (value: { sessionVersion: number }) => unknown) => select({ sessionVersion: 1 }), { getState: () => ({ sessionVersion: 1 }), subscribe: () => () => undefined }) }));
vi.mock("@/components/model-picker", () => ({ ModelPicker: () => null }));
vi.mock("@/components/canvas/canvas-image-settings-popover", () => ({ CanvasImageSettingsPopover: () => null }));
vi.mock("@/components/canvas/canvas-audio-settings-popover", () => ({ CanvasAudioSettingsPopover: () => null }));
vi.mock("@/components/canvas/canvas-video-settings-popover", () => ({ CanvasVideoSettingsPopover: () => null }));
vi.mock("@/components/canvas/canvas-text-settings-popover", () => ({ CanvasTextSettingsPopover: () => null }));
vi.mock("antd", () => ({
    Button: ({ children, disabled, onClick }: { children: ReactNode; disabled: boolean; onClick: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
    Segmented: () => null,
    message: { warning: vi.fn() },
}));

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
const { CanvasConfigNodePanel } = await import("@/components/canvas/canvas-config-node-panel");
const { CanvasEmptyGuide } = await import("@/components/canvas/canvas-empty-guide");
const { defaultConfig, useConfigStore } = await import("@/stores/use-config-store");
const { initI18n } = await import("@/i18n");
const current = { id: "config", type: "config", title: "配置", width: 340, height: 240, position: { x: 0, y: 0 }, metadata: { prompt: "画一片森林", count: 2 } };
const callbacks = { onConfigChange: vi.fn(), onGenerate: vi.fn(), onStop: vi.fn(), onComposerToggle: vi.fn() };
const props = { node: current, nodes: [current], connections: [], isRunning: false, inputSummary: { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 }, ...callbacks };

beforeAll(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    await initI18n();
    useConfigStore.setState({ config: { ...defaultConfig, imageModel: "platform::image", audioModel: "platform::audio", videoModel: "platform::video", platformModels: [{ name: "image", capability: "image" }, { name: "audio", capability: "audio" }, { name: "video", capability: "video" }] } });
});
afterEach(() => { cleanup(); quote.error = null; quote.ready = true; vi.clearAllMocks(); });

test("空画布示例只填入提示词，三个入口调用各自现有动作", () => {
    const onDescribe = vi.fn();
    const onUpload = vi.fn();
    const onTemplates = vi.fn();
    const onCanvasDown = vi.fn();
    render(<div onMouseDown={onCanvasDown} onPointerDown={onCanvasDown} onClick={onCanvasDown} onDoubleClick={onCanvasDown}><CanvasEmptyGuide onDescribe={onDescribe} onUpload={onUpload} onTemplates={onTemplates} /></div>);
    fireEvent.pointerDown(screen.getByRole("button", { name: /试试这个描述/ }));
    fireEvent.mouseDown(screen.getByRole("button", { name: /试试这个描述/ }));
    fireEvent.click(screen.getByRole("button", { name: /试试这个描述/ }));
    fireEvent.doubleClick(screen.getByRole("button", { name: /试试这个描述/ }));
    expect(onCanvasDown).not.toHaveBeenCalled();
    expect(onDescribe).toHaveBeenCalledWith(expect.stringContaining("橘猫"));
    fireEvent.click(screen.getByRole("button", { name: "描述生成图片" }));
    expect(onDescribe).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByRole("button", { name: "上传素材" }));
    fireEvent.click(screen.getByRole("button", { name: "使用模板" }));
    expect(onUpload).toHaveBeenCalledOnce();
    expect(onTemplates).toHaveBeenCalledOnce();
    expect(screen.getByText(/使用模板会创建新画布/)).toBeInTheDocument();
});

test("配置生成按钮展示后端冻结费用，报价失败后就地说明并禁用", () => {
    const view = render(<CanvasConfigNodePanel {...props} />);
    expect(screen.getByText("¥0.24")).toBeInTheDocument();
    expect(screen.getByText(/冻结不是最终扣费/)).toBeInTheDocument();
    const generate = screen.getByRole("button", { name: "开始生成" });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    expect(callbacks.onGenerate).toHaveBeenCalledWith("config", undefined);
    quote.error = new Error("模型暂不可用");
    view.rerender(<CanvasConfigNodePanel {...props} />);
    expect(generate).toBeDisabled();
    expect(screen.getByText(/费用暂不可用：模型暂不可用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新获取费用" }));
    expect(quote.refetch).toHaveBeenCalledOnce();
});

test("音频配置缺少朗读文本以及只读画布均不请求报价，并显示具体原因", () => {
    const audioNode = { ...current, metadata: { generationMode: "audio" as const } };
    const view = render(<CanvasConfigNodePanel {...props} node={audioNode} nodes={[audioNode]} inputSummary={{ textCount: 0, imageCount: 1, videoCount: 0, audioCount: 0 }} />);
    expect(screen.getByRole("button", { name: "开始生成" })).toBeDisabled();
    expect(screen.getByText("请填写朗读内容，或连接有内容的文本节点")).toBeInTheDocument();
    expect(quote.enabled).toBe(false);
    view.rerender(<CanvasConfigNodePanel {...props} readOnly />);
    expect(screen.getByText("此画布为只读，无法生成")).toBeInTheDocument();
    expect(quote.enabled).toBe(false);
});

test("仅接图片的视频配置仍可报价与生成", () => {
    const videoNode = { ...current, metadata: { generationMode: "video" as const } };
    const reference = { ...current, id: "reference", type: "image", metadata: { content: "/api/media/11111111-1111-1111-1111-111111111111", storageKey: "image:11111111-1111-1111-1111-111111111111" } };
    render(<CanvasConfigNodePanel {...props} node={videoNode} nodes={[videoNode, reference]} connections={[{ id: "reference-config", fromNodeId: reference.id, toNodeId: videoNode.id }]} />);
    expect(quote.enabled).toBe(true);
    expect(screen.getByRole("button", { name: "开始生成" })).toBeEnabled();
});
