import type { FocusFrame } from "./canvas-node-geometry";

export function measureFocusFrame(container: HTMLDivElement | null, nodeId: string): FocusFrame {
    if (!container) return {};
    const id = CSS.escape(nodeId);
    const section = container.parentElement;
    const canvasRect = container.getBoundingClientRect();
    const toolbarRect = section?.querySelector<HTMLElement>(`[data-node-toolbar="${id}"]`)?.getBoundingClientRect();
    const dockRect = section?.querySelector<HTMLElement>("[data-canvas-bottom-toolbar]")?.getBoundingClientRect();
    if (canvasRect.width < 1024) {
        const topBarRect = section?.querySelector<HTMLElement>("[data-canvas-top-bar]")?.getBoundingClientRect();
        const panelRect = section?.querySelector<HTMLElement>(`:scope > [data-node-panel="${id}"]`)?.getBoundingClientRect();
        // Fixed overlays reserve screen space; they must not move or grow with the node.
        return {
            above: Math.max(0, (toolbarRect?.bottom ?? canvasRect.top) - canvasRect.top, (topBarRect?.bottom ?? canvasRect.top) - canvasRect.top),
            bottomInset: Math.max(0, canvasRect.bottom - (panelRect?.top ?? canvasRect.bottom), canvasRect.bottom - (dockRect?.top ?? canvasRect.bottom)),
        };
    }
    const node = container.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
    const nodeRect = node?.getBoundingClientRect();
    const panelRect = node?.querySelector<HTMLElement>("[data-node-panel]")?.getBoundingClientRect();
    const below = nodeRect && panelRect ? Math.max(0, panelRect.bottom - nodeRect.bottom) : 0;
    const above = nodeRect && toolbarRect ? Math.max(0, nodeRect.top - toolbarRect.top) : 0;
    return { above, below, bottomInset: dockRect && below > 0 ? Math.max(0, canvasRect.bottom - dockRect.top) : 0 };
}
