import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodeType, type ViewportTransform } from "@/types/canvas";

vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: (select: (state: { theme: string }) => unknown) => select({ theme: "light" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/image-utils", () => ({ formatBytes: () => "" }));
vi.mock("@/lib/canvas/node-registry", () => ({ getNodeDefinition: () => undefined }));
vi.mock("@/lib/canvas/plugin-node-context", () => ({ buildNodeContext: () => null }));
vi.mock("@/services/image-storage", () => ({ getImagePreviewRevision: () => 0, previewUrlFor: () => undefined, subscribeImagePreviews: () => () => undefined }));
vi.mock("@/components/canvas/canvas-resource-mention-textarea", () => ({ CanvasResourceMentionTextarea: () => null }));

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(25, 40, 800, 600));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

// jsdom has no pointer capture/retargeting. Individual tests dispatch the browser's
// capture-loss event explicitly, so they verify handling without claiming native touch coverage.
function capture(element: HTMLElement) {
    const pointers = new Set<number>();
    element.setPointerCapture = vi.fn((id: number) => { pointers.add(id); });
    element.hasPointerCapture = (id: number) => pointers.has(id);
    element.releasePointerCapture = vi.fn((id: number) => { pointers.delete(id); });
}

function pointer(target: HTMLElement | Window, type: string, id: number, x: number, y: number, isPrimary = true) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" }, isPrimary: { value: isPrimary } });
    fireEvent(target, event);
    return event;
}
const frame = () => act(() => { vi.runOnlyPendingTimers(); });

function renderCanvas(initial: ViewportTransform = { x: 10, y: 20, k: 1 }, tool: "pan" | "select" = "pan") {
    const changed = vi.fn();
    const deselect = vi.fn();
    const gesture = vi.fn();
    const selection = vi.fn();
    const nodeDown = vi.fn();
    const action = vi.fn();
    function Canvas() {
        const containerRef = useRef<HTMLDivElement>(null);
        const [viewport, setViewport] = useState(initial);
        return <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool={tool} onViewportChange={(next) => { changed(next); setViewport(next); }} onCanvasDeselect={deselect} onGestureStart={gesture} onCanvasMouseDown={selection}>
            <div data-testid="node" data-node-id="test" onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); nodeDown(); }}>节点</div>
            <div data-canvas-no-zoom><textarea aria-label="提示词" /><button onClick={action}>设置</button></div>
        </InfiniteCanvas>;
    }
    const view = render(<Canvas />);
    const surface = view.container.firstElementChild as HTMLDivElement;
    const node = screen.getByTestId("node");
    capture(surface);
    capture(node);
    return { surface, node, changed, deselect, gesture, selection, nodeDown, action, viewport: (): ViewportTransform => changed.mock.lastCall?.[0] || initial };
}

test("单指平移只响应发起手指，拖动不取消选择，单击空白仍可取消选择", () => {
    const canvas = renderCanvas();
    pointer(canvas.surface, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 99, 600, 500, false);
    frame();
    expect(canvas.changed).not.toHaveBeenCalled();
    pointer(window, "pointermove", 1, 140, 130);
    frame();
    expect(canvas.viewport()).toEqual({ x: 50, y: 50, k: 1 });
    pointer(window, "pointerup", 1, 140, 130);
    expect(canvas.deselect).not.toHaveBeenCalled();
    pointer(canvas.surface, "pointerdown", 2, 100, 100);
    pointer(window, "pointerup", 2, 100, 100);
    expect(canvas.deselect).toHaveBeenCalledOnce();
});

test("双指以手指中心对应的画布点缩放，同时跟随中心平移", () => {
    const canvas = renderCanvas({ x: 40, y: 20, k: 2 });
    pointer(canvas.surface, "pointerdown", 1, 225, 240);
    pointer(canvas.surface, "pointerdown", 2, 425, 240, false);
    pointer(window, "pointermove", 1, 175, 260);
    pointer(window, "pointermove", 2, 475, 260, false);
    frame();
    const viewport = canvas.viewport();
    expect(viewport.k).toBeCloseTo(3);
    // World point (130, 90), initially under the midpoint, stays under its new screen position.
    expect(25 + viewport.x + 130 * viewport.k).toBeCloseTo(325);
    expect(40 + viewport.y + 90 * viewport.k).toBeCloseTo(260);
    expect(canvas.gesture).toHaveBeenCalledOnce();
    expect(canvas.selection).not.toHaveBeenCalled();
    expect(canvas.deselect).not.toHaveBeenCalled();
});

test("双指抬起一指后不误平移或点击，全部结束后的新触摸可继续操作", () => {
    const canvas = renderCanvas();
    pointer(canvas.surface, "pointerdown", 1, 100, 100);
    pointer(canvas.surface, "pointerdown", 2, 200, 100, false);
    pointer(window, "pointermove", 2, 300, 100, false);
    frame();
    const zoomed = canvas.viewport();
    pointer(window, "pointerup", 2, 300, 100, false);
    pointer(window, "pointermove", 1, 150, 150);
    frame();
    expect(canvas.viewport()).toEqual(zoomed);
    pointer(window, "pointerup", 1, 150, 150);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(canvas.action).not.toHaveBeenCalled();
    expect(canvas.deselect).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "设置" });
    pointer(button, "pointerdown", 3, 100, 100);
    pointer(button, "pointerup", 3, 100, 100);
    fireEvent.click(button);
    expect(canvas.action).toHaveBeenCalledOnce();
    pointer(canvas.surface, "pointerdown", 4, 100, 100);
    pointer(window, "pointermove", 4, 130, 140);
    pointer(window, "pointerup", 4, 130, 140);
    expect(canvas.viewport()).toEqual({ ...zoomed, x: zoomed.x + 30, y: zoomed.y + 40 });
});

test.each(["pointercancel", "lostpointercapture"])("%s 取消未提交移动，不把取消当作点击或保留旧手势", (endEvent) => {
    const canvas = renderCanvas();
    pointer(canvas.surface, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 180, 160);
    pointer(canvas.surface, endEvent, 1, 180, 160);
    frame();
    pointer(window, "pointerup", 1, 180, 160);
    expect(canvas.changed).not.toHaveBeenCalled();
    expect(canvas.deselect).not.toHaveBeenCalled();
    pointer(canvas.surface, "pointerdown", 2, 100, 100);
    pointer(window, "pointermove", 2, 120, 110);
    frame();
    expect(canvas.viewport()).toEqual({ x: 30, y: 30, k: 1 });
});

test("节点捕获转交画布时保留第一根手指，第二指不触发节点操作或框选", () => {
    const canvas = renderCanvas({ x: 0, y: 0, k: 1 }, "select");
    pointer(canvas.node, "pointerdown", 1, 100, 100);
    pointer(canvas.node, "pointerdown", 2, 200, 100, false);
    canvas.node.releasePointerCapture(1);
    pointer(canvas.node, "lostpointercapture", 1, 100, 100);
    pointer(window, "pointermove", 2, 300, 100, false);
    frame();
    expect(canvas.viewport().k).toBeCloseTo(2);
    expect(canvas.nodeDown).toHaveBeenCalledOnce();
    expect(canvas.gesture).toHaveBeenCalledOnce();
    expect(canvas.selection).not.toHaveBeenCalled();
    pointer(window, "pointerup", 1, 100, 100);
    pointer(window, "pointerup", 2, 300, 100, false);
    expect(canvas.deselect).not.toHaveBeenCalled();
});

test("三指变为双指时连续平移，结束后不会残留手势", () => {
    const canvas = renderCanvas({ x: 0, y: 0, k: 1 });
    pointer(canvas.surface, "pointerdown", 1, 100, 100);
    pointer(canvas.surface, "pointerdown", 2, 300, 100, false);
    pointer(window, "pointermove", 2, 500, 100, false);
    frame();
    const zoomed = canvas.viewport();
    pointer(canvas.surface, "pointerdown", 3, 600, 100, false);
    pointer(window, "pointerup", 1, 100, 100);
    expect(canvas.viewport()).toEqual(zoomed);
    pointer(window, "pointermove", 2, 550, 120, false);
    pointer(window, "pointermove", 3, 650, 120, false);
    frame();
    expect(canvas.viewport()).toEqual({ ...zoomed, x: zoomed.x + 50, y: zoomed.y + 20 });
    pointer(window, "pointerup", 2, 550, 120, false);
    pointer(window, "pointerup", 3, 650, 120, false);
    const finished = canvas.viewport();
    pointer(window, "pointermove", 3, 900, 700, false);
    frame();
    expect(canvas.viewport()).toEqual(finished);
    expect(canvas.deselect).not.toHaveBeenCalled();
});

test("输入区域保留原生触摸，其外的第二指不会独自拖动画布", () => {
    const canvas = renderCanvas();
    const input = screen.getByRole("textbox", { name: "提示词" });
    pointer(input, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 100, 180);
    pointer(canvas.surface, "pointerdown", 2, 200, 100, false);
    pointer(window, "pointermove", 2, 200, 180, false);
    frame();
    expect(canvas.changed).not.toHaveBeenCalled();
    expect(canvas.gesture).not.toHaveBeenCalled();
    expect(canvas.selection).not.toHaveBeenCalled();
});

test("配置节点内容不拦截滚动触摸，标题仍可拖动并切换到双指缩放", () => {
    const drag = vi.fn();
    const gesture = vi.fn();
    const changed = vi.fn();
    const noop = () => undefined;
    function ConfigCanvas() {
        const containerRef = useRef<HTMLDivElement>(null);
        const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
        return <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool="pan" onViewportChange={(next) => { changed(next); setViewport(next); }} onGestureStart={gesture}>
            <CanvasNode
                data={{ id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 340, height: 240 }}
                scale={viewport.k} isSelected isRelated={false} isFocusRelated={false} isConnectionTarget={false} isConnecting={false} showPanel={false} showImageInfo={false}
                renderNodeContent={() => <div><div data-canvas-node-drag-handle className="touch-none">拖动配置</div><div>配置滚动内容</div></div>}
                onPointerDown={(event) => { event.stopPropagation(); drag(); }} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop}
                onResizeStart={noop} onResize={noop} onResizeEnd={noop} onContentChange={noop} onTitleChange={noop} onContextMenu={noop}
            />
        </InfiniteCanvas>;
    }
    const view = render(<ConfigCanvas />);
    const surface = view.container.firstElementChild as HTMLDivElement;
    capture(surface);
    const scrollStart = pointer(screen.getByText("配置滚动内容"), "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 100, 170);
    pointer(window, "pointerup", 1, 100, 170);
    frame();
    expect(scrollStart.defaultPrevented).toBe(false);
    expect(drag).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    pointer(screen.getByText("拖动配置"), "pointerdown", 2, 100, 100);
    expect(drag).toHaveBeenCalledOnce();
    pointer(surface, "pointerdown", 3, 200, 100, false);
    pointer(window, "pointermove", 3, 300, 100, false);
    frame();
    expect(gesture).toHaveBeenCalledOnce();
    expect(changed.mock.lastCall?.[0].k).toBeCloseTo(2);
});
