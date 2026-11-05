import { nodeBounds, GROUP_WRAP_PADDING } from "./canvas-node-geometry";
import type { CanvasNodeData } from "@/types/canvas";

export type ArrangeAction = "left" | "centerX" | "right" | "top" | "centerY" | "bottom" | "distributeHorizontal" | "distributeVertical" | "grid";

export function arrangementRoots(nodes: CanvasNodeData[], selected: Set<string>) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return nodes.filter((node) => {
        if (!selected.has(node.id)) return false;
        const visited = new Set([node.id]);
        let parent = node.metadata?.groupId;
        while (parent && !visited.has(parent)) {
            if (selected.has(parent) && byId.get(parent)?.type === "group") return false;
            visited.add(parent);
            parent = byId.get(parent)?.metadata?.groupId;
        }
        return true;
    });
}

export function arrangeCanvasNodes(nodes: CanvasNodeData[], selected: Set<string>, action: ArrangeAction) {
    const roots = arrangementRoots(nodes, selected);
    if (roots.length < 2 || action.startsWith("distribute") && roots.length < 3) return nodes;
    const bounds = nodeBounds(roots);
    const targets = new Map<string, { x: number; y: number }>();
    if (action === "grid") {
        const columns = Math.ceil(Math.sqrt(roots.length));
        const gap = GROUP_WRAP_PADDING * 2;
        const width = Math.max(...roots.map((node) => node.width));
        const height = Math.max(...roots.map((node) => node.height));
        [...roots].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).forEach((node, index) => targets.set(node.id, { x: bounds.left + index % columns * (width + gap), y: bounds.top + Math.floor(index / columns) * (height + gap) }));
    } else if (action === "distributeHorizontal" || action === "distributeVertical") {
        const horizontal = action === "distributeHorizontal";
        const axis = horizontal ? "x" : "y";
        const dimension = horizontal ? "width" : "height";
        const ordered = [...roots].sort((a, b) => a.position[axis] - b.position[axis]);
        const span = horizontal ? bounds.right - bounds.left : bounds.bottom - bounds.top;
        const gap = (span - roots.reduce((sum, node) => sum + node[dimension], 0)) / (roots.length - 1);
        let position = horizontal ? bounds.left : bounds.top;
        ordered.forEach((node) => { targets.set(node.id, { ...node.position, [axis]: position }); position += node[dimension] + gap; });
    } else {
        roots.forEach((node) => targets.set(node.id, {
            x: action === "left" ? bounds.left : action === "right" ? bounds.right - node.width : action === "centerX" ? (bounds.left + bounds.right - node.width) / 2 : node.position.x,
            y: action === "top" ? bounds.top : action === "bottom" ? bounds.bottom - node.height : action === "centerY" ? (bounds.top + bounds.bottom - node.height) / 2 : node.position.y,
        }));
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return nodes.map((node) => {
        let root = node;
        const visited = new Set<string>();
        while (!targets.has(root.id) && root.metadata?.groupId && !visited.has(root.id)) {
            visited.add(root.id);
            const parent = byId.get(root.metadata.groupId);
            if (!parent || parent.type !== "group") break;
            root = parent;
        }
        const target = targets.get(root.id);
        if (!target) return node;
        const x = node.position.x + target.x - root.position.x;
        const y = node.position.y + target.y - root.position.y;
        return x === node.position.x && y === node.position.y ? node : { ...node, position: { x, y } };
    });
}
