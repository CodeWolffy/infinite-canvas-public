import { expect, test, vi } from "vitest";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/canvas/node-registry", () => ({ getNodeDefinition: () => undefined }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn() }));
import { buildCanvasGraph } from "@/lib/canvas/canvas-graph";
import { buildNodeMentionReferences, getGenerationResourceNodes, getGroupResourceNodes, isCanvasReferenceNode } from "@/lib/canvas/canvas-resource-references";

const node = (id: string, x = 0, type = CanvasNodeType.Text) => ({ id, type, title: id, position: { x, y: 0 }, width: 100, height: 100, metadata: { content: id } }) as CanvasNodeData;
const edge = (fromNodeId: string, toNodeId: string) => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId }) as CanvasConnection;

test("索引保留配置节点优先、组内展开、位置排序和去重语义", () => {
    const nodes = [node("a", 20), node("b", 10), node("group", 0, CanvasNodeType.Group), node("target"), node("config", 0, CanvasNodeType.Config)];
    nodes[0].metadata!.groupId = "group";
    const connections = [edge("group", "config"), edge("b", "config"), edge("target", "config"), edge("b", "target")];
    const graph = buildCanvasGraph(nodes, connections);
    expect(buildNodeMentionReferences(nodes[3], nodes, connections, graph).map((item) => item.id)).toEqual(["a", "b"]);
    expect(getGenerationResourceNodes("target", nodes, connections, graph).map((item) => item.id)).toEqual(["group", "b"]);
    expect(buildNodeMentionReferences(nodes[0], nodes, [], buildCanvasGraph(nodes, [])).map((item) => item.id)).toEqual(["a"]);
});

test("大画布引用计算不会为每条连线重新扫描全部节点", () => {
    let reads = 0;
    const nodes = Array.from({ length: 1200 }, (_, index) => {
        const item = node(String(index));
        Object.defineProperty(item, "id", { get: () => { reads++; return String(index); } });
        return item;
    });
    const connections = nodes.slice(1).map((_, index) => edge(String(index), String(index + 1)));
    const graph = buildCanvasGraph(nodes, connections);
    const references = nodes.map((item) => buildNodeMentionReferences(item, nodes, connections, graph));
    expect(references[1199][0].id).toBe("1198");
    expect(reads).toBeLessThan(nodes.length * 20);
});

test("同一大组用于引用选择与多条输入时只展开一次，节点变化后重新计算", () => {
    const group = node("group", 0, CanvasNodeType.Group);
    const target = node("target");
    let reads = 0;
    const members = Array.from({ length: 1200 }, (_, index) => {
        const item = node(String(index));
        const metadata = { content: item.id, groupId: group.id };
        Object.defineProperty(item, "metadata", { get: () => { reads++; return metadata; } });
        return item;
    });
    const nodes = [group, target, ...members];
    const connections = [edge(group.id, target.id)];
    const graph = buildCanvasGraph(nodes, connections);
    reads = 0;
    for (let i = 0; i < 1200; i++) {
        expect(isCanvasReferenceNode(group, nodes, graph)).toBe(true);
        expect(getGenerationResourceNodes(target.id, nodes, connections, graph)[0]).toBe(group);
    }
    expect(getGroupResourceNodes(group.id, nodes, graph)).toHaveLength(1200);
    expect(reads).toBeLessThan(members.length * 5);
    const emptyNodes = [group, target];
    expect(isCanvasReferenceNode(group, emptyNodes, buildCanvasGraph(emptyNodes, connections))).toBe(false);
});
