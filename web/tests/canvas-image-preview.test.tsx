import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CanvasImagePreview } from "@/components/canvas/canvas-image-preview";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";

const session = vi.hoisted(() => ({ sessionVersion: 1 }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => session } }));
vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: (select: (state: { theme: string }) => unknown) => select({ theme: "light" }) }));

beforeEach(() => {
    session.sessionVersion = 1;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} })));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
        const stage = this.firstElementChild instanceof HTMLImageElement;
        const viewport = this.parentElement?.parentElement;
        return new DOMRect(stage ? parseFloat(this.style.left) - (viewport?.scrollLeft || 0) : 0, stage ? parseFloat(this.style.top) - (viewport?.scrollTop || 0) : 0, stage ? parseFloat(this.style.width) : 1000, stage ? parseFloat(this.style.height) : 800);
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const batchImage = (id: string, content = `/media/${id}`): CanvasNodeImage => ({ id, content, status: "success", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" });
const node = (images = [batchImage("a"), batchImage("b")]): CanvasNodeData => ({ id: "node", type: CanvasNodeType.Image, title: "预览图片", width: 240, height: 240, position: { x: 0, y: 0 }, metadata: { content: images[0].content, images, primaryImageId: images[0].id } });
const currentImage = () => document.querySelector("img") as HTMLImageElement;
const button = (key: string) => screen.getByRole("button", { name: key });
function loadImage(image = currentImage(), width = 2000, height = 1600) {
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
    fireEvent.load(image);
}
function pointer(element: HTMLElement, type: string, x: number, y: number, pointerId = 1) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    fireEvent(element, event);
}
function mockPointerCapture(element: HTMLElement) {
    element.setPointerCapture = vi.fn();
    element.hasPointerCapture = () => true;
    element.releasePointerCapture = vi.fn();
}

test("切图立即隐藏旧图片，同尺寸新图加载后重置缩放，下载对应当前图", () => {
    const download = vi.fn();
    render(<CanvasImagePreview node={node()} initialImageId={null} onClose={vi.fn()} onDownload={download} />);
    const first = currentImage();
    expect(first).not.toBeVisible();
    loadImage(first);
    fireEvent.click(button("canvas.imagePreview.original"));
    const viewport = first.parentElement!.parentElement!.parentElement!;
    mockPointerCapture(viewport);
    pointer(viewport, "pointerdown", 500, 400);
    pointer(viewport, "pointermove", 600, 450);
    fireEvent.click(button("canvas.imagePreview.next"));
    const second = currentImage();
    expect(first).not.toBeInTheDocument();
    expect(second).toHaveAttribute("src", "/media/b");
    expect(second).not.toBeVisible();
    fireEvent.load(first);
    expect(second).not.toBeVisible();
    expect(button("common.download")).toBeDisabled();
    loadImage(second);
    pointer(viewport, "pointermove", 700, 500);
    expect(second).toBeVisible();
    expect(button("canvas.editors.zoomOut")).toBeDisabled();
    const stage = second.parentElement!.getBoundingClientRect();
    expect(stage.left + stage.width / 2).toBeCloseTo(500);
    expect(stage.top + stage.height / 2).toBeCloseTo(400);
    fireEvent.click(button("common.download"));
    expect(download).toHaveBeenCalledWith("b");
    fireEvent.click(button("canvas.imagePreview.previous"));
    expect(currentImage()).not.toBeVisible();
    expect(screen.getByRole("status")).toBeInTheDocument();
});

test("同一图片编号替换源地址也重新加载，失败重试不复用坏图或旧加载状态", () => {
    const props = { initialImageId: null, onClose: vi.fn(), onDownload: vi.fn() };
    const view = render(<CanvasImagePreview node={node([batchImage("a")])} {...props} />);
    const old = currentImage();
    loadImage(old);
    view.rerender(<CanvasImagePreview node={node([batchImage("a", "/media/replaced")])} {...props} />);
    expect(currentImage()).not.toBeVisible();
    expect(old).not.toBeInTheDocument();
    fireEvent.error(currentImage());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    const failed = currentImage();
    fireEvent.click(button("canvas.node.retry"));
    expect(failed).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.load(failed);
    expect(currentImage()).not.toBeVisible();
    loadImage();
    expect(currentImage()).toBeVisible();
});

test.each([null, "a"])("从主图或指定备选图打开，忽略未生成图片（%s）", (initialImageId) => {
    const data = node([batchImage("a"), batchImage("pending", ""), batchImage("b")]);
    data.metadata!.primaryImageId = "b";
    data.metadata!.content = "/media/b";
    render(<CanvasImagePreview node={data} initialImageId={initialImageId} onClose={vi.fn()} onDownload={vi.fn()} />);
    expect(currentImage()).toHaveAttribute("src", initialImageId ? "/media/a" : "/media/b");
    expect(screen.getByText(initialImageId ? "1 / 2" : "2 / 2")).toBeInTheDocument();
});

test("原始尺寸使用实际图片比例，大图超过四倍适应倍率仍能100%并双击还原", () => {
    render(<CanvasImagePreview node={node([batchImage("a")])} initialImageId={null} onClose={vi.fn()} onDownload={vi.fn()} />);
    loadImage(currentImage(), 10000, 6000);
    const stage = currentImage().parentElement!;
    expect(parseFloat(stage.style.width) / parseFloat(stage.style.height)).toBeCloseTo(5 / 3);
    fireEvent.click(button("canvas.imagePreview.original"));
    expect(parseFloat(stage.style.width)).toBeCloseTo(10000);
    expect(parseFloat(stage.style.height)).toBeCloseTo(6000);
    expect(stage.parentElement!.parentElement).toHaveClass("overflow-hidden");
    fireEvent.doubleClick(currentImage(), { clientX: 500, clientY: 400 });
    expect(parseFloat(stage.style.width)).toBeLessThan(1000);
    fireEvent.doubleClick(currentImage(), { clientX: 500, clientY: 400 });
    expect(parseFloat(stage.style.width)).toBeCloseTo(10000);
});

test("滚轮以鼠标所在像素为缩放锚点，左键可以拖动放大图片", () => {
    render(<CanvasImagePreview node={node([batchImage("a")])} initialImageId={null} onClose={vi.fn()} onDownload={vi.fn()} />);
    loadImage();
    fireEvent.click(button("canvas.imagePreview.original"));
    const stage = currentImage().parentElement!;
    const viewport = stage.parentElement!.parentElement!;
    mockPointerCapture(viewport);
    const before = stage.getBoundingClientRect();
    const pointBefore = { x: (600 - before.left) / before.width, y: (400 - before.top) / before.height };
    const background = vi.fn();
    window.addEventListener("wheel", background);
    try {
        fireEvent.wheel(viewport, { deltaY: -100, clientX: 600, clientY: 400 });
        expect(background).not.toHaveBeenCalled();
    } finally { window.removeEventListener("wheel", background); }
    const enlarged = stage.getBoundingClientRect();
    expect((600 - enlarged.left) / enlarged.width).toBeCloseTo(pointBefore.x);
    expect((400 - enlarged.top) / enlarged.height).toBeCloseTo(pointBefore.y);
    pointer(viewport, "pointerdown", 600, 400);
    pointer(viewport, "pointermove", 650, 440);
    expect(stage.getBoundingClientRect().left).toBeCloseTo(enlarged.left + 50);
    expect(stage.getBoundingClientRect().top).toBeCloseTo(enlarged.top + 40);
    pointer(viewport, "pointerup", 650, 440);
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(1);
});

test.each([[2000, 1600], [240, 180], [2000, 200]])("适应时和未溢出的方向也可拖动，适应按钮恢复居中（%i×%i）", (width, height) => {
    render(<CanvasImagePreview node={node([batchImage("a")])} initialImageId={null} onClose={vi.fn()} onDownload={vi.fn()} />);
    loadImage(currentImage(), width, height);
    const stage = currentImage().parentElement!;
    const viewport = stage.parentElement!.parentElement!;
    mockPointerCapture(viewport);
    const initial = stage.getBoundingClientRect();
    pointer(viewport, "pointerdown", 500, 400);
    pointer(viewport, "pointermove", 560, 450);
    pointer(viewport, "pointerup", 560, 450);
    expect(stage.getBoundingClientRect().left).toBeCloseTo(initial.left + 60);
    expect(stage.getBoundingClientRect().top).toBeCloseTo(initial.top + 50);
    fireEvent.click(button("canvas.imagePreview.fit"));
    expect(stage.getBoundingClientRect().left).toBeCloseTo(initial.left);
    expect(stage.getBoundingClientRect().top).toBeCloseTo(initial.top);
    fireEvent.click(button("canvas.editors.zoomIn"));
    expect(stage.getBoundingClientRect().width).toBeGreaterThan(initial.width);
    const enlarged = stage.getBoundingClientRect();
    pointer(viewport, "pointerdown", 500, 400);
    pointer(viewport, "pointermove", 560, 450);
    pointer(viewport, "pointerup", 560, 450);
    expect(stage.getBoundingClientRect().left).toBeCloseTo(enlarged.left + 60);
    expect(stage.getBoundingClientRect().top).toBeCloseTo(enlarged.top + 50);
    fireEvent.click(button("canvas.imagePreview.fit"));
    expect(stage.getBoundingClientRect().left).toBeCloseTo(initial.left);
    expect(stage.getBoundingClientRect().top).toBeCloseTo(initial.top);
    expect(stage.getBoundingClientRect().width).toBeCloseTo(initial.width);
});

test("第二个指针不会抢走拖动，取消指针后停止移动", () => {
    render(<CanvasImagePreview node={node([batchImage("a")])} initialImageId={null} onClose={vi.fn()} onDownload={vi.fn()} />);
    loadImage();
    const stage = currentImage().parentElement!;
    const viewport = stage.parentElement!.parentElement!;
    mockPointerCapture(viewport);
    const initial = stage.getBoundingClientRect();
    pointer(viewport, "pointerdown", 500, 400);
    pointer(viewport, "pointerdown", 600, 450, 2);
    pointer(viewport, "pointermove", 700, 500, 2);
    expect(stage.getBoundingClientRect().left).toBeCloseTo(initial.left);
    pointer(viewport, "pointermove", 550, 430);
    pointer(viewport, "pointercancel", 550, 430);
    pointer(viewport, "pointermove", 650, 500);
    expect(stage.getBoundingClientRect().left).toBeCloseTo(initial.left + 50);
    expect(stage.getBoundingClientRect().top).toBeCloseTo(initial.top + 30);
    expect(viewport).not.toHaveClass("cursor-grabbing");
});

test("真实Modal初始焦点支持左右和Esc，编辑快捷键及空格不泄漏给底层画布", async () => {
    const close = vi.fn();
    render(<CanvasImagePreview node={node()} initialImageId={null} onClose={close} onDownload={vi.fn()} />);
    await waitFor(() => expect(document.activeElement?.closest(".ant-modal")).not.toBeNull());
    const background = vi.fn();
    window.addEventListener("keydown", background);
    try {
        loadImage();
        const target = button("canvas.imagePreview.original");
        target.focus();
        for (const key of ["Delete", " ", "Control", "z", "v"]) fireEvent.keyDown(target, { key, code: key === " " ? "Space" : undefined, ctrlKey: key === "z" || key === "v" });
        fireEvent.keyDown(target, { key: "ArrowRight" });
        expect(currentImage()).toHaveAttribute("src", "/media/b");
        expect(document.activeElement?.closest(".ant-modal")).not.toBeNull();
        expect(document.activeElement).not.toBe(target);
        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
        expect(close).toHaveBeenCalledOnce();
        expect(background).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", background); }
});

test("退出会话后迟到的图片加载结果不显示", () => {
    render(<CanvasImagePreview node={node()} initialImageId={null} onClose={vi.fn()} onDownload={vi.fn()} />);
    session.sessionVersion = 2;
    loadImage();
    expect(currentImage()).not.toBeVisible();
    expect(button("common.download")).toBeDisabled();
});

test("编辑模式仍能在裁剪手柄上用空格加左键平移", () => {
    const crop = vi.fn();
    function Editor() {
        const viewport = useImageEditorViewport({ width: 2000, height: 1600 }, true);
        return <div ref={viewport.viewportRef} {...viewport.panHandlers} data-testid="editor"><div ref={viewport.stageRef}><button onPointerDown={crop}>裁剪手柄</button></div></div>;
    }
    render(<Editor />);
    const viewport = screen.getByTestId("editor");
    mockPointerCapture(viewport);
    viewport.scrollLeft = 200;
    viewport.scrollTop = 100;
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    pointer(button("裁剪手柄"), "pointerdown", 500, 400);
    expect(viewport.setPointerCapture).toHaveBeenCalledWith(1);
    expect(crop).not.toHaveBeenCalled();
    pointer(viewport, "pointermove", 550, 420);
    expect(viewport.scrollLeft).toBe(150);
    expect(viewport.scrollTop).toBe(80);
    pointer(viewport, "pointerup", 550, 420);
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(1);
    fireEvent.keyUp(window, { key: " ", code: "Space" });
});
