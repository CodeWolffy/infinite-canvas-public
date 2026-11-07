import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useGenerationQuote } from "@/hooks/use-generation-quote";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { audioGenerationParameters } from "@/services/api/audio";
import { platformImageParameters, platformTextInput } from "@/services/api/image";
import { mediaId, mediaUrl } from "@/services/api/media";
import { ensurePlatformMedia } from "@/services/api/tasks";
import type { quoteGeneration } from "@/services/api/platform-operations";
import { videoGenerationParameters } from "@/services/api/video";
import { findChannelModel, modelOptionName } from "@/stores/use-config-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { buildNodeResponseMessages } from "./canvas-node-generation";
import { canvasGenerationImages, canvasGenerationInputKey, type CanvasGenerationMedia, type PreparedCanvasGenerationMedia, type prepareCanvasNodeGeneration } from "./canvas-generation-preparation";

type Preparation = ReturnType<typeof prepareCanvasNodeGeneration>;
type Reference = CanvasGenerationMedia["referenceImages"][number] | CanvasGenerationMedia["referenceVideos"][number] | CanvasGenerationMedia["referenceAudios"][number];

function referenceMediaId(reference: Reference, mode: CanvasGenerationMode) {
    const keyId = reference.storageKey ? mediaId(reference.storageKey) : undefined;
    const url = "dataUrl" in reference ? reference.dataUrl : reference.url;
    const urlId = url?.match(/\/api\/media\/([0-9a-f-]{36})(?:$|[?#])/i)?.[1];
    // 与真实提交一致：文本读取图片正文，图片优先存储键，视频的非图片引用优先 URL。
    const id = mode === "text" && url && !url.startsWith("blob:") ? urlId : mode === "video" && !("dataUrl" in reference) ? urlId || keyId : keyId || urlId;
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

function generationReferences(node: CanvasNodeData, mode: CanvasGenerationMode, prepared: Preparation): CanvasGenerationMedia {
    const { context, config, writeBackToSelf } = prepared;
    return {
        referenceImages: mode === "audio" ? [] : mode === "image" && !writeBackToSelf ? canvasGenerationImages(node, context, config.nodeRegenerateBehavior === "overwrite") : context.referenceImages,
        referenceVideos: mode === "video" ? context.referenceVideos : [],
        referenceAudios: mode === "video" ? context.referenceAudios : [],
    };
}

export function canvasNodeQuoteInput(node: CanvasNodeData, mode: CanvasGenerationMode, prepared: Preparation, media?: CanvasGenerationMedia): Parameters<typeof quoteGeneration>[0] {
    const { config, context, count } = prepared;
    const modelId = modelOptionName(config.model);
    const model = findChannelModel(config, config.model)?.model;
    if (!model || model.name !== modelId || model.capability !== mode) throw new Error("请选择可用模型；没有可选模型时请联系管理员配置渠道");
    const { referenceImages: images, referenceVideos, referenceAudios } = media || generationReferences(node, mode, prepared);
    const references = [...images, ...referenceVideos, ...referenceAudios];
    const attachmentMediaIds = references.map((reference) => {
        const id = referenceMediaId(reference, mode);
        if (!id) throw new Error("参考素材尚未保存到平台，请先准备素材并获取费用");
        return id;
    });
    if (mode === "text") {
        const conversationId = count === 1 ? node.metadata?.conversationId : undefined;
        const { content, systemPrompt, parameters } = platformTextInput(config, buildNodeResponseMessages({ ...context, referenceImages: images }), conversationId);
        return { modelId, count: 1, content, systemPrompt, conversationId, parameters, attachmentMediaIds };
    }
    return {
        modelId, count, attachmentMediaIds,
        content: mode === "image" && images.length ? buildImageReferencePromptText(context.prompt, images) : context.prompt,
        parameters: mode === "image" ? platformImageParameters(config) : mode === "video" ? videoGenerationParameters(config) : audioGenerationParameters(config),
    };
}

export function useCanvasGenerationQuote(node: CanvasNodeData, mode: CanvasGenerationMode, prompt: string, prepared: Preparation, isRunning: boolean, readOnly: boolean) {
    const { id: projectId = "" } = useParams();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const inputKey = canvasGenerationInputKey(node, mode, prepared);
    const identity = useMemo(() => ({}), [inputKey, projectId, sessionVersion, readOnly]);
    const current = useRef(identity);
    current.current = identity;
    const controller = useRef<AbortController | null>(null);
    const [material, setMaterial] = useState<{ identity: object; loading?: boolean; error?: string; prepared?: PreparedCanvasGenerationMedia } | null>(null);
    useLayoutEffect(() => { current.current = identity; return () => { current.current = {}; controller.current?.abort(); }; }, [identity]);
    const preparedMedia = material?.identity === identity ? material.prepared : undefined;
    const preparingMedia = material?.identity === identity && Boolean(material.loading);
    const mediaError = material?.identity === identity ? material.error : undefined;
    const references = generationReferences(node, mode, prepared);
    const needsPreparation = !preparedMedia && Object.values(references).some((items: Reference[]) => items.some((reference) => !referenceMediaId(reference, mode)));
    const prepareMedia = async () => {
        if (readOnly || isRunning || preparingMedia || controller.current && !controller.current.signal.aborted) return;
        const request = new AbortController();
        controller.current = request;
        const assertCurrent = () => {
            assertCurrentSession(sessionVersion);
            if (current.current !== identity || request.signal.aborted) throw new DOMException("输入已变化", "AbortError");
        };
        setMaterial({ identity, loading: true });
        try {
            const prepareReference = async <T extends Reference>(reference: T): Promise<T> => {
                assertCurrent();
                if (referenceMediaId(reference, mode)) return reference;
                const source = mode === "text" && "dataUrl" in reference && !reference.dataUrl.startsWith("blob:") ? { ...reference, storageKey: undefined, url: reference.dataUrl } : reference;
                const id = await ensurePlatformMedia(source, request.signal);
                assertCurrent();
                return { ...reference, storageKey: `media:${id}`, ...("dataUrl" in reference ? { dataUrl: mediaUrl(id), url: mediaUrl(id) } : { url: mediaUrl(id) }) };
            };
            const preparedReferences: CanvasGenerationMedia = { referenceImages: [], referenceVideos: [], referenceAudios: [] };
            for (const reference of references.referenceImages) preparedReferences.referenceImages.push(await prepareReference(reference));
            for (const reference of references.referenceVideos) preparedReferences.referenceVideos.push(await prepareReference(reference));
            for (const reference of references.referenceAudios) preparedReferences.referenceAudios.push(await prepareReference(reference));
            assertCurrent();
            setMaterial({ identity, prepared: { inputKey, projectId, sessionVersion, references: preparedReferences } });
        } catch (error) {
            if (current.current === identity && useUserStore.getState().sessionVersion === sessionVersion && !request.signal.aborted) setMaterial({ identity, error: error instanceof Error ? error.message : "素材准备失败，请重试" });
        } finally {
            if (controller.current === request) controller.current = null;
        }
    };
    let input: Parameters<typeof quoteGeneration>[0] = { modelId: "", count: prepared.count, content: "" };
    let reason = readOnly ? "此画布为只读，无法生成" : !prompt.trim() && node.type !== CanvasNodeType.Config ? "请先填写提示词" : "";
    try { input = canvasNodeQuoteInput(node, mode, prepared, preparedMedia?.references); }
    catch (error) { if (!reason) reason = error instanceof Error ? error.message : "生成参数不可用，请检查配置"; }
    if (!readOnly && needsPreparation) reason = preparingMedia ? "正在准备参考素材…" : mediaError || "参考素材尚未保存到平台，请先准备素材并获取费用";
    const allowEmptyContent = node.type === CanvasNodeType.Config && mode === "video" && Boolean(input.attachmentMediaIds?.length);
    if (!reason && !allowEmptyContent && !(mode === "image" ? input.content : prepared.context.prompt).trim()) reason = mode === "audio" ? "请填写朗读内容，或连接有内容的文本节点" : "请填写提示词，或连接有内容的文本节点";
    const quote = useGenerationQuote(input, !reason && !isRunning, allowEmptyContent);
    if (!reason && !isRunning) reason = quote.error ? `费用暂不可用：${quote.error.message}` : !quote.ready ? "正在获取本次费用，请稍候" : "";
    return { ...quote, count: prepared.count, preparedMedia, prepareMedia, preparingMedia, needsPreparation: !readOnly && !isRunning && needsPreparation, reason: isRunning ? "生成中，停止等待后后台仍会继续生成和结算" : reason, canGenerate: !reason && quote.ready && !isRunning };
}
