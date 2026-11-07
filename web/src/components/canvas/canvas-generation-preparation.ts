import i18n from "@/i18n";
import { buildGenerationConfig, getGenerationCount } from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { buildNodeGenerationContext, type NodeGenerationContext } from "./canvas-node-generation";

export type CanvasGenerationMedia = Pick<NodeGenerationContext, "referenceImages" | "referenceVideos" | "referenceAudios">;
export type PreparedCanvasGenerationMedia = { inputKey: string; projectId: string; sessionVersion: number; references: CanvasGenerationMedia };

export function canvasGenerationInputKey(node: CanvasNodeData, mode: CanvasGenerationMode, prepared: ReturnType<typeof prepareCanvasNodeGeneration>) {
    return JSON.stringify({ nodeId: node.id, mode, prepared, conversationId: node.metadata?.conversationId, images: mode === "image" && !prepared.writeBackToSelf ? canvasGenerationImages(node, prepared.context, prepared.config.nodeRegenerateBehavior === "overwrite") : undefined });
}

/** 报价与提交共用提示词、引用顺序及节点覆盖配置。这里只准备数据，不上传或生成。 */
export function prepareCanvasNodeGeneration(config: AiConfig, node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], mode: CanvasGenerationMode, prompt: string) {
    const generationConfig = buildGenerationConfig(config, node, mode);
    const builtinPanel = getNodeDefinition(node.type)?.useBuiltinPanel;
    const writeBackToSelf = Boolean(builtinPanel?.writeBackToSelf && builtinPanel.mode === "image");
    const sourceTextContent = node.type === CanvasNodeType.Text ? node.metadata?.content?.trim() || "" : "";
    const editingTextNode = mode === "text" && Boolean(sourceTextContent);
    const fullPrompt = writeBackToSelf ? (builtinPanel?.promptPrefix || "") + prompt.trim()
        : editingTextNode ? i18n.t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt;
    const context = buildNodeGenerationContext(node.id, nodes, connections, fullPrompt);
    if (!writeBackToSelf) context.prompt = context.prompt.trim();
    const count = writeBackToSelf ? 1 : mode === "image" ? getGenerationCount(generationConfig.count) : mode === "text" ? getGenerationCount(String(node.metadata?.textCount || 1)) : 1;
    return { config: generationConfig, context, count, writeBackToSelf, sourceTextContent, editingTextNode };
}

export function canvasGenerationImages(node: CanvasNodeData, context: NodeGenerationContext, overwriteExisting: boolean) {
    const sourceReference = node.type === CanvasNodeType.Image && node.metadata?.content && !overwriteExisting
        ? [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }]
        : [];
    return [...new Map([...sourceReference, ...context.referenceImages].map((image) => [image.id, image])).values()];
}
