import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";

vi.mock("antd", () => ({ App: { useApp: () => ({ message: {} }) } }));
const session = vi.hoisted(() => ({ sessionVersion: 1 }));
vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn() }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => session } }));

const { useCanvasClipboard } = await import("@/pages/canvas/hooks/use-canvas-clipboard");
const { CanvasNodeType } = await import("@/types/canvas");
type CanvasNodeData = import("@/types/canvas").CanvasNodeData;
type CanvasConnection = import("@/types/canvas").CanvasConnection;

test("粘贴保留外部输入参考、重连内部参考，并忽略已删除的参考来源", () => {
    const node = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, width: 100, height: 100, position: { x: 0, y: 0 } });
    const nodesRef = { current: [node("reference"), node("a"), node("b"), node("outside")] };
    const connectionsRef = { current: [
        { id: "inbound", fromNodeId: "reference", toNodeId: "a" },
        { id: "internal", fromNodeId: "a", toNodeId: "b" },
        { id: "outbound", fromNodeId: "b", toNodeId: "outside" },
    ] };
    let addedNodes: CanvasNodeData[] = [];
    let addedConnections: CanvasConnection[] = [];
    const { result, unmount } = renderHook(() => useCanvasClipboard({
        canEdit: () => true, nodesRef, connectionsRef, selectedNodeIdsRef: { current: new Set(["a", "b"]) },
        getCanvasCenter: () => ({ x: 100, y: 100 }), screenToCanvas: () => ({ x: 0, y: 0 }),
        setNodes: (update) => { addedNodes = typeof update === "function" ? update([]) : update; },
        setConnections: (update) => { addedConnections = typeof update === "function" ? update([]) : update; },
        setSelectedNodeIds: vi.fn(), setSelectedConnectionId: vi.fn(), setContextMenu: vi.fn(), setDialogNodeId: vi.fn(),
    }));
    try {
        result.current.copySelectedNodes();
        expect(result.current.pasteCopiedNodes()).toBe(true);
        expect(addedConnections).toMatchObject([
            { fromNodeId: "reference", toNodeId: addedNodes[0].id },
            { fromNodeId: addedNodes[0].id, toNodeId: addedNodes[1].id },
        ]);
        nodesRef.current = nodesRef.current.filter((item) => item.id !== "reference");
        result.current.pasteCopiedNodes();
        expect(addedConnections).toMatchObject([{ fromNodeId: addedNodes[0].id, toNodeId: addedNodes[1].id }]);
        session.sessionVersion++;
        expect(result.current.pasteCopiedNodes()).toBe(false);
    } finally {
        unmount();
    }
});
