import { afterEach, expect, test, vi } from "vitest";
import { measureFocusFrame } from "@/lib/canvas/canvas-focus-frame";
import { focusViewportForNode } from "@/lib/canvas/canvas-node-geometry";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

function element(parent: HTMLElement, attributes: Record<string, string>, rect: DOMRect) {
    const node = document.createElement("div");
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
    node.getBoundingClientRect = () => rect;
    parent.append(node);
    return node;
}

test.each([{ width: 390, height: 700, panelTop: 390 }, { width: 844, height: 390, panelTop: 230 }])("紧凑画布$width×$height聚焦后节点位于固定工具栏与底部面板之间", ({ width, height, panelTop }) => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const section = element(document.body, {}, new DOMRect(25, 40, width, height));
    const canvas = element(section, {}, new DOMRect(25, 40, width, height));
    element(canvas, { "data-node-id": "node" }, new DOMRect(-500, 900, 340, 240));
    element(section, { "data-canvas-top-bar": "" }, new DOMRect(25, 40, width, 56));
    const toolbar = element(section, { "data-node-toolbar": "node" }, new DOMRect(33, 96, width - 16, 48));
    const panel = element(section, { "data-node-panel": "node" }, new DOMRect(33, panelTop, width - 16, 180));
    element(section, { "data-canvas-bottom-toolbar": "" }, new DOMRect(33, height - 28, width - 16, 56));
    // Another open canvas must not affect this canvas's measured chrome.
    element(document.body, { "data-node-toolbar": "node" }, new DOMRect(0, -500, 2000, 2000));
    const node = { position: { x: -500, y: 900 }, width: 340, height: 240 };
    const focus = () => focusViewportForNode(node, { width, height }, measureFocusFrame(canvas, "node"));
    const viewport = focus();
    const top = 40 + viewport.y + node.position.y * viewport.k;
    const bottom = top + node.height * viewport.k;
    expect(top).toBeGreaterThanOrEqual(toolbar.getBoundingClientRect().bottom);
    expect(bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().top);
    expect(viewport.x + (node.position.x + node.width / 2) * viewport.k).toBeCloseTo(width / 2);
    canvas.firstElementChild!.getBoundingClientRect = () => new DOMRect(100, -2000, 340, 240);
    expect(focus()).toEqual(viewport);
});

test("紧凑画布没有节点工具栏时，聚焦仍避开主顶栏和底栏", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const section = element(document.body, {}, new DOMRect(0, 20, 600, 390));
    const canvas = element(section, {}, new DOMRect(0, 20, 600, 390));
    element(section, { "data-canvas-top-bar": "" }, new DOMRect(0, 20, 600, 56));
    element(section, { "data-canvas-bottom-toolbar": "" }, new DOMRect(8, 342, 584, 56));
    const node = { position: { x: 0, y: 0 }, width: 340, height: 600 };
    const viewport = focusViewportForNode(node, { width: 600, height: 390 }, measureFocusFrame(canvas, "node"));
    expect(20 + viewport.y).toBeGreaterThanOrEqual(76);
    expect(20 + viewport.y + node.height * viewport.k).toBeLessThanOrEqual(342);
});

test("宽画布仍将节点与跟随面板一起聚焦，并为底栏留出空间", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const section = element(document.body, {}, new DOMRect(0, 0, 1280, 800));
    const canvas = element(section, {}, new DOMRect(0, 0, 1280, 800));
    const item = element(canvas, { "data-node-id": "node" }, new DOMRect(300, 200, 340, 240));
    element(item, { "data-node-panel": "node" }, new DOMRect(170, 456, 600, 300));
    element(section, { "data-node-toolbar": "node" }, new DOMRect(170, 138, 600, 48));
    element(section, { "data-canvas-bottom-toolbar": "" }, new DOMRect(300, 724, 800, 56));
    const node = { position: { x: 0, y: 0 }, width: 340, height: 240 };
    const viewport = focusViewportForNode(node, { width: 1280, height: 800 }, measureFocusFrame(canvas, "node"));
    const wholeTop = viewport.y - 62;
    const wholeBottom = viewport.y + node.height * viewport.k + 316;
    expect(wholeTop).toBeGreaterThanOrEqual(0);
    expect(wholeBottom).toBeLessThanOrEqual(724);
    expect(724 - wholeBottom).toBeCloseTo(wholeTop / 3);
});
