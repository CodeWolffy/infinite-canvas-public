import { expect, test } from "vitest";
import { arrangeCanvasNodes, arrangementRoots } from "@/lib/canvas/canvas-arrange";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number, width = 100, height = 80, groupId?: string): CanvasNodeData => ({ id, title: id, type: CanvasNodeType.Image, position: { x, y }, width, height, metadata: { groupId } });

test("对齐保持节点尺寸与未选元素，原数据可供撤销", () => {
    const nodes = [node("a", 20, 30), node("b", 400, 200, 150, 60), node("c", 800, 800)];
    const arranged = arrangeCanvasNodes(nodes, new Set(["a", "b"]), "right");
    expect(arranged[0].position.x + arranged[0].width).toBe(arranged[1].position.x + arranged[1].width);
    expect(arranged[0]).toMatchObject({ width: 100, height: 80, position: { y: 30 } });
    expect(arranged[2]).toBe(nodes[2]);
    expect(nodes[0].position).toEqual({ x: 20, y: 30 });
});

test("组和成员同时选中时只移动一次，未直接选中的组成员跟随", () => {
    const nodes = [{ ...node("g", 400, 50, 300, 250), type: CanvasNodeType.Group }, node("child", 430, 90, 60, 60, "g"), node("other-child", 500, 140, 80, 80, "g"), node("a", 0, 0)];
    const selected = new Set(["g", "child", "a"]);
    expect(arrangementRoots(nodes, selected).map((item) => item.id)).toEqual(["g", "a"]);
    const arranged = arrangeCanvasNodes(nodes, selected, "left");
    expect(arranged[0].position.x).toBe(0);
    expect(arranged[1].position.x).toBe(30);
    expect(arranged[2].position.x).toBe(100);
    expect(arrangeCanvasNodes(nodes, selected, "distributeHorizontal")).toBe(nodes);
});

test("不同宽度节点按边缘间距分布，网格不重叠", () => {
    const nodes = [node("a", 0, 20, 100), node("b", 120, 100, 200), node("c", 600, 60, 60)];
    const selected = new Set(nodes.map((item) => item.id));
    const arranged = arrangeCanvasNodes(nodes, selected, "distributeHorizontal");
    expect(arranged[1].position.x - arranged[0].position.x - arranged[0].width).toBe(arranged[2].position.x - arranged[1].position.x - arranged[1].width);
    const grid = arrangeCanvasNodes(nodes, selected, "grid");
    for (let i = 0; i < grid.length; i++) for (let j = i + 1; j < grid.length; j++) {
        const a = grid[i], b = grid[j];
        expect(a.position.x + a.width <= b.position.x || b.position.x + b.width <= a.position.x || a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y).toBe(true);
    }
});
