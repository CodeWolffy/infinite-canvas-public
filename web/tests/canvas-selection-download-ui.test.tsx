import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as icons from "lucide-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadModule, readSource } from "./support/source-loader";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasThemes } from "@/lib/canvas-theme";

const api = vi.hoisted(() => ({ export: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), session: 1 }));
vi.mock("@/lib/canvas/canvas-export", () => ({ exportCanvasNodes: api.export }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: { info: api.info, success: api.success, error: api.error, loading: api.loading } }) } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ sessionVersion: api.session }) }, assertCurrentSession: (session: number) => { if (session !== api.session) throw new DOMException("会话已改变", "AbortError"); } }));
import { useDownloadCanvasSelection } from "@/hooks/use-download-canvas-selection";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";

const noop = () => undefined;
const children = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const panelState = { width: 320, panelOpen: true, panelMounted: true, panelClosing: false, setWidth: noop, nodeViewMode: "grid", setNodeViewMode: noop, closePanel: vi.fn() };
const translations: Record<string, string> = { "canvas.sidePanel.select": "选择", "canvas.sidePanel.canvas": "画布", "common.cancel": "取消" };
const t = (key: string, options?: { count?: number }) => key === "canvas.sidePanel.selected" ? `已选 ${options?.count} 项` : translations[key] || key;
const input = ({ value, onChange, placeholder }: any) => <input value={value} onChange={onChange} placeholder={placeholder} />;
const imports = {
    react: React, "react/jsx-runtime": jsxRuntime, "lucide-react": icons,
    antd: { App: { useApp: () => ({ message: {} }) }, Empty: Object.assign(children, { PRESENTED_IMAGE_SIMPLE: "empty" }), Input: input, Popconfirm: children, Select: () => null, Spin: () => null, Tag: children, Dropdown: children, Tooltip: children },
    "@tanstack/react-query": { useQuery: noop }, "motion/react": { motion: { div: children, aside: children, span: children } }, "react-i18next": { useTranslation: () => ({ t }) },
    "@/lib/canvas-theme": { canvasThemes }, "@/lib/canvas/canvas-node-geometry": { nodeBounds }, "@/hooks/use-download-canvas-selection": { useDownloadCanvasSelection },
    "@/lib/canvas/node-registry": { getNodeDefinition: () => undefined }, "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
    "@/components/prompts/prompt-detail-dialog": { PromptDetailDialog: () => null }, "@/services/api/prompts": { fetchSourcePrompts: noop },
    "@/services/image-storage": { getImagePreviewRevision: () => 0, previewUrlFor: () => "", subscribeImagePreviews: () => noop, uploadImage: noop },
    "@/services/file-storage": { uploadMediaFile: noop }, "@/stores/use-user-store": { assertCurrentSession: noop, useUserStore: noop },
    "@/stores/use-asset-store": { useAssetStore: noop }, "@/stores/use-prompt-source-store": { usePromptSourceStore: noop },
    "@/stores/use-canvas-side-panel-store": { useCanvasSidePanelStore: (selector: any) => selector(panelState), CANVAS_SIDE_PANEL_MAX_WIDTH: 500, CANVAS_SIDE_PANEL_MIN_WIDTH: 200, CANVAS_SIDE_PANEL_MOTION_MS: 200 },
    "@/stores/use-theme-store": { useThemeStore: (selector: any) => selector({ theme: "light" }) }, "@/types/canvas": { CanvasNodeType },
};
const context = { window, document, navigator, localStorage, setTimeout, clearTimeout };
const { CanvasSelectionToolbar } = loadModule(readSource("components/canvas/canvas-selection-toolbar.tsx"), context, imports);
const { CanvasSidePanel } = loadModule(readSource("components/canvas/canvas-side-panel.tsx"), context, imports);
const node = (id: string, type = CanvasNodeType.Text, groupId?: string): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { content: `${id}内容`, groupId } });
const nodes = [node("组", CanvasNodeType.Group), node("图片", CanvasNodeType.Image, "组"), node("文案", CanvasNodeType.Text, "组"), node("其他")];
const toolbarProps = { viewport: { x: 0, y: 0, k: 1 }, showToolbar: true, canGroup: true, canUngroup: true, onGroup: noop, onUngroup: noop, onArrange: noop, arrangeDisabled: { distributeHorizontal: true, distributeVertical: true } };

beforeEach(() => {
    api.session = 1; api.export.mockReset().mockResolvedValue(undefined); api.info.mockReset(); api.success.mockReset(); api.error.mockReset(); api.loading.mockReset().mockReturnValue(noop); panelState.closePanel.mockReset();
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: true, media, addEventListener: noop, removeEventListener: noop }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("选区包含组和组内成员时完整下载并按节点去重", async () => {
    render(<CanvasSelectionToolbar {...toolbarProps} nodes={[nodes[0], nodes[1]]} allNodes={nodes} />);
    fireEvent.click(screen.getByRole("button", { name: "下载选中内容" }));
    await waitFor(() => expect(api.export).toHaveBeenCalledOnce());
    expect(api.export.mock.calls[0][0].map((item: CanvasNodeData) => item.id)).toEqual(["图片", "文案"]);
    expect(api.success).toHaveBeenCalledWith("已下载 2 项选中内容");
});

test("只读画布选中单组仍可下载且不显示编辑动作", async () => {
    render(<CanvasSelectionToolbar {...toolbarProps} nodes={[nodes[0]]} allNodes={nodes} readOnly />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "下载选中内容" }));
    await waitFor(() => expect(api.export).toHaveBeenCalledOnce());
});

test("空组选区明确提示没有可下载内容", () => {
    const group = node("空组", CanvasNodeType.Group);
    render(<CanvasSelectionToolbar {...toolbarProps} nodes={[group]} allNodes={[group]} />);
    fireEvent.click(screen.getByRole("button", { name: "下载选中内容" }));
    expect(api.info).toHaveBeenCalledWith(expect.stringContaining("没有可下载内容"));
    expect(api.export).not.toHaveBeenCalled();
});

test("下载失败后显示具体原因并恢复按钮", async () => {
    api.export.mockRejectedValue(new Error("文件已失效"));
    render(<CanvasSelectionToolbar {...toolbarProps} nodes={[nodes[1], nodes[2]]} allNodes={nodes} />);
    fireEvent.click(screen.getByRole("button", { name: "下载选中内容" }));
    await waitFor(() => expect(api.error).toHaveBeenCalledWith("下载失败：文件已失效"));
    expect(screen.getByRole("button", { name: "下载选中内容" })).toBeEnabled();
});

test("侧栏首次选择采用当前选区，之后勾选不修改画布选择", async () => {
    const selected = new Set(["图片", "文案"]);
    const focus = vi.fn();
    render(<CanvasSidePanel nodes={nodes} selectedNodeIds={selected} onFocusNode={focus} onPreviewNode={noop} onHoverNode={noop} onInsertAsset={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    expect(screen.getByText("已选 2 项")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "其他" }));
    expect(screen.getByText("已选 3 项")).toBeInTheDocument();
    expect([...selected]).toEqual(["图片", "文案"]);
    expect(focus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "下载选中内容" }));
    await waitFor(() => expect(api.export).toHaveBeenCalledOnce());
    expect(api.export.mock.calls[0][0].map((item: CanvasNodeData) => item.id)).toEqual(["图片", "文案", "其他"]);
});

test("侧栏再次进入选择采用最新画布选区，不沿用上次独立勾选", () => {
    const props = { nodes, onFocusNode: noop, onPreviewNode: noop, onHoverNode: noop, onInsertAsset: noop };
    const view = render(<CanvasSidePanel {...props} selectedNodeIds={new Set(["图片", "文案"])} />);
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "其他" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    view.rerender(<CanvasSidePanel {...props} selectedNodeIds={new Set(["组"])} />);
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
});

test("同会话切换项目期间继续打包原选区，不混入新项目节点", async () => {
    let finish!: () => void;
    api.export.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const view = render(<CanvasSelectionToolbar {...toolbarProps} nodes={[nodes[1], nodes[2]]} allNodes={nodes} />);
    fireEvent.click(screen.getByRole("button", { name: "下载选中内容" }));
    const next = [node("新项目一"), node("新项目二")];
    view.rerender(<CanvasSelectionToolbar {...toolbarProps} nodes={next} allNodes={next} />);
    expect(api.export.mock.calls[0][0].map((item: CanvasNodeData) => item.id)).toEqual(["图片", "文案"]);
    await act(async () => finish());
    expect(api.success).toHaveBeenCalledWith("已下载 2 项选中内容");
});

test("切换登录会话后不显示旧下载成功提示", async () => {
    let finish!: () => void;
    api.export.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<CanvasSelectionToolbar {...toolbarProps} nodes={[nodes[1], nodes[2]]} allNodes={nodes} />);
    fireEvent.click(screen.getByRole("button", { name: "下载选中内容" }));
    api.session++;
    await act(async () => finish());
    expect(api.success).not.toHaveBeenCalled();
    expect(api.error).not.toHaveBeenCalled();
});

test("手机侧栏关闭按钮与遮罩共用现有关闭动作，桌面调整柄保留", () => {
    render(<CanvasSidePanel nodes={nodes} selectedNodeIds={new Set()} onFocusNode={noop} onPreviewNode={noop} onHoverNode={noop} onInsertAsset={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭画布侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭画布侧栏遮罩" }));
    expect(panelState.closePanel).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "canvas.sidePanel.resize" })).toHaveClass("hidden", "lg:block");
});
