import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export function buildCanvasGraph(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const nodeById = new Map<string, CanvasNodeData>();
    const incoming = new Map<string, CanvasConnection[]>();
    const outgoing = new Map<string, CanvasConnection[]>();
    const members = new Map<string, CanvasNodeData[]>();
    for (const node of nodes) {
        nodeById.set(node.id, node);
        if (node.metadata?.groupId) {
            const group = members.get(node.metadata.groupId) || [];
            group.push(node);
            members.set(node.metadata.groupId, group);
        }
    }
    for (const connection of connections) {
        const inputs = incoming.get(connection.toNodeId) || [];
        const outputs = outgoing.get(connection.fromNodeId) || [];
        inputs.push(connection);
        outputs.push(connection);
        incoming.set(connection.toNodeId, inputs);
        outgoing.set(connection.fromNodeId, outputs);
    }
    return { nodeById, incoming, outgoing, members };
}

export type CanvasGraph = ReturnType<typeof buildCanvasGraph>;
