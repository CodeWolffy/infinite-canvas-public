import type { CanvasNodeData, CanvasNodeText } from "@/types/canvas";

export function textGenerationRequests(node: CanvasNodeData) {
    if (node.type !== "text") return [];
    const texts = node.metadata?.texts;
    if (texts?.some((text) => text.textRequestId)) return texts;
    const metadata = node.metadata;
    return metadata?.textRequestId ? [{ id: node.id, content: metadata.content || "", status: metadata.status || "idle", textRequestId: metadata.textRequestId, conversationId: metadata.conversationId } satisfies CanvasNodeText] : [];
}

export function hasTextGenerationRequest(node: CanvasNodeData) {
    return textGenerationRequests(node).some((text) => text.textRequestId);
}

export function applyTextGenerationProgress(node: CanvasNodeData, requestId: string, content: string): CanvasNodeData {
    const target = textGenerationRequests(node).find((text) => text.textRequestId === requestId && text.status === "loading");
    if (!target || target.content === content) return node;
    const primary = !node.metadata?.texts?.length || !node.metadata.primaryTextId || node.metadata.primaryTextId === target.id;
    return { ...node, metadata: { ...node.metadata, ...(primary ? { content } : {}), ...(node.metadata?.texts ? { texts: node.metadata.texts.map((text) => text.textRequestId === requestId ? { ...text, content } : text) } : {}) } };
}

export function applyTextGenerationResult(node: CanvasNodeData, requestId: string, result: Pick<CanvasNodeText, "content" | "status" | "errorDetails">): CanvasNodeData {
    const requests = textGenerationRequests(node);
    if (!requests.some((text) => text.textRequestId === requestId && text.status === "loading")) return node;
    const texts = requests.map((text) => text.textRequestId === requestId ? { ...text, ...result } : text);
    const primary = texts.find((text) => text.id === node.metadata?.primaryTextId && text.status === "success") || texts.find((text) => text.status === "success");
    const pending = texts.some((text) => text.status === "loading");
    return {
        ...node,
        metadata: {
            ...node.metadata,
            ...(node.metadata?.texts?.some((text) => text.textRequestId) ? { texts, primaryTextId: primary?.id || node.metadata.primaryTextId } : {}),
            content: primary?.content || "",
            conversationId: primary?.conversationId || node.metadata?.conversationId,
            textRequestId: primary?.textRequestId || node.metadata?.textRequestId,
            status: pending ? "loading" : primary ? "success" : "error",
            errorDetails: pending || primary ? undefined : texts.find((text) => text.errorDetails)?.errorDetails,
        },
    };
}
