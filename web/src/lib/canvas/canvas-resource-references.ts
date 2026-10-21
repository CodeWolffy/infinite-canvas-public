import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasGraph, type CanvasGraph } from "@/lib/canvas/canvas-graph";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    text?: string;
    active: boolean;
};

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], graph?: CanvasGraph) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections, graph), true);
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes, true);
}

export async function resolveCanvasReferenceImages(references: CanvasResourceReference[], nodes: CanvasNodeData[]) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    return Promise.all(references.filter((reference) => reference.kind === "image").map(async (reference) => {
        const node = nodesById.get(reference.nodeId);
        if (!node) throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: reference.title }));
        const metadata = node.metadata;
        const dataUrl = await imageToDataUrl({ storageKey: metadata?.storageKey, url: reference.previewUrl });
        if (!dataUrl.startsWith("data:image/")) throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
        const meta = metadata?.naturalWidth && metadata.naturalHeight
            ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return {
            id: `canvas:${node.id}`,
            name: reference.title,
            type: metadata?.mimeType || meta.mimeType,
            size: metadata?.bytes || getDataUrlByteSize(dataUrl),
            width: meta.width,
            height: meta.height,
            url: reference.previewUrl || dataUrl,
            dataUrl,
        };
    }));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], graph = buildCanvasGraph(nodes, connections)) {
    const configInputs = expandGroupResourceNodes(getConnectedConfigInputNodes(nodeId, graph), graph);
    if (configInputs.length) return configInputs;
    const ownInputs = expandGroupResourceNodes(getContextInputNodes(nodeId, graph), graph);
    if (ownInputs.length) return ownInputs;
    const node = graph.nodeById.get(nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], graph = buildCanvasGraph(nodes, connections)) {
    const configInputs = getConnectedConfigInputNodes(nodeId, graph);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextInputNodes(nodeId, graph);
    if (ownInputs.length) return ownInputs;
    return [];
}

const contextInputCache = new WeakMap<CanvasGraph, Map<string, CanvasNodeData[]>>();

function getContextInputNodes(nodeId: string, graph: CanvasGraph) {
    let inputs = contextInputCache.get(graph);
    if (!inputs) contextInputCache.set(graph, inputs = new Map());
    const cached = inputs.get(nodeId);
    if (cached) return cached;
    const nodes = (graph.incoming.get(nodeId) || [])
        .map((connection) => graph.nodeById.get(connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && (isResourceNode(node) || node.type === CanvasNodeType.Group && groupResources(node.id, graph).length)))
        .sort((a, b) => {
            const diffY = a.position.y - b.position.y;
            if (Math.abs(diffY) > 8) return diffY;
            return a.position.x - b.position.x;
        });
    inputs.set(nodeId, nodes);
    return nodes;
}

function getConnectedConfigInputNodes(nodeId: string, graph: CanvasGraph) {
    const configConnection = graph.outgoing.get(nodeId)?.find((connection) => graph.nodeById.get(connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextInputNodes(configConnection.toNodeId, graph).filter((node) => node.id !== nodeId);
}

function hasGroupResources(node: CanvasNodeData, nodes: CanvasNodeData[], graph?: CanvasGraph) {
    return node.type === CanvasNodeType.Group && getGroupResourceNodes(node.id, nodes, graph).length > 0;
}

export function isCanvasReferenceNode(node: CanvasNodeData, nodes: CanvasNodeData[], graph?: CanvasGraph) {
    return isResourceNode(node) || hasGroupResources(node, nodes, graph);
}

function expandGroupResourceNodes(inputNodes: CanvasNodeData[], graph: CanvasGraph) {
    const resources = inputNodes.flatMap((node) => (node.type === CanvasNodeType.Group ? groupResources(node.id, graph) : [node]));
    return [...new Map(resources.map((node) => [node.id, node])).values()];
}

const groupResourceCache = new WeakMap<CanvasGraph, Map<string, CanvasNodeData[]>>();

function groupResources(groupId: string, graph: CanvasGraph) {
    let groups = groupResourceCache.get(graph);
    if (!groups) groupResourceCache.set(graph, groups = new Map());
    let resources = groups.get(groupId);
    if (!resources) groups.set(groupId, resources = (graph.members.get(groupId) || []).filter(isResourceNode));
    return resources;
}

export function getGroupResourceNodes(groupId: string, nodes: CanvasNodeData[], graph?: CanvasGraph) {
    return graph ? groupResources(groupId, graph) : nodes.filter((node) => node.metadata?.groupId === groupId && isResourceNode(node));
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.content || resource?.url,
                text: resourceText(node),
                active,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (kind === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return resource?.kind === "text" ? resource.text : undefined;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility through definition.resource.
    return getNodeDefinition(node.type)?.resource?.(node)?.kind || null;
}
