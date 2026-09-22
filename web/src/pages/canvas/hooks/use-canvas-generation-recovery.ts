import { useEffect, useLayoutEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { TFunction } from "i18next";

import { getGenerationBatch } from "@/services/api/generation";
import { watchTextRequest, type TextRequestDetail } from "@/services/api/text";
import { ApiError } from "@/services/api/request";
import { applyTextGenerationProgress, applyTextGenerationResult, hasTextGenerationRequest, textGenerationRequests } from "@/lib/canvas/canvas-text-generation";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";

export type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

type PendingImage = { nodeId: string; image: CanvasNodeImage };
type PendingText = { nodeId: string; requestId: string };

type CanvasGenerationRecoveryParams = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    projectLoaded: boolean;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    t: TFunction;
    generationRequestsRef: MutableRefObject<Map<string, CanvasGenerationRequest>>;
};

const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

/**
 * 刷新页面后恢复仍在进行中的生成：图片任务按批次轮询，文本请求优先复用已有 SSE，
 * 并把 Config 节点的汇总状态与其子节点同步。定时器与订阅只跟随 pending 列表，
 * 节点其他字段变化不会重建。
 */
export function useCanvasGenerationRecovery({ nodes, connections, projectLoaded, setNodes, t, generationRequestsRef }: CanvasGenerationRecoveryParams) {
    const restoringGenerationImagesRef = useRef(new Set<string>());
    const missingTextRequestsRef = useRef(new Map<string, number>());

    const pendingImages = useMemo<PendingImage[]>(
        () =>
            nodes.flatMap((node) => {
                if (generationRequestsRef.current.has(node.id)) return [];
                return (node.metadata?.images || []).flatMap((image) => (image.status === NODE_STATUS_LOADING && image.generationBatchId ? [{ nodeId: node.id, image }] : []));
            }),
        [generationRequestsRef, nodes],
    );
    const pendingImageKey = useMemo(() => pendingImages.map(({ nodeId, image }) => `${nodeId}:${image.id}:${image.generationBatchId}`).join(","), [pendingImages]);
    const pendingImagesRef = useRef(pendingImages);
    useLayoutEffect(() => {
        pendingImagesRef.current = pendingImages;
    });

    const pendingText = useMemo<PendingText[]>(
        () => nodes.flatMap((node) => textGenerationRequests(node).filter((text) => text.status === NODE_STATUS_LOADING && text.textRequestId).map((text) => ({ nodeId: node.id, requestId: text.textRequestId! }))),
        [nodes],
    );
    const pendingTextKey = useMemo(() => pendingText.map(({ nodeId, requestId }) => `${nodeId}:${requestId}`).join(","), [pendingText]);
    const pendingTextRef = useRef(pendingText);
    useLayoutEffect(() => {
        pendingTextRef.current = pendingText;
    });

    useEffect(() => {
        if (!projectLoaded) return;
        const pending = pendingImagesRef.current;
        if (!pending.length) return;
        let disposed = false;
        const pollPendingImage = async (nodeId: string, pendingImage: CanvasNodeImage) => {
            const batchId = pendingImage.generationBatchId!;
            const restoreKey = `${nodeId}:${pendingImage.id}:${batchId}`;
            if (restoringGenerationImagesRef.current.has(restoreKey)) return;
            restoringGenerationImagesRef.current.add(restoreKey);
            try {
                const detail = await getGenerationBatch(batchId);
                if (disposed) return;
                const task = pendingImage.generationTaskId
                    ? detail.tasks.find((item) => item.id === pendingImage.generationTaskId)
                    : detail.tasks.length === 1
                      ? detail.tasks[0]
                      : undefined;
                if (!task) {
                    const errorDetails = t("canvas.projectPage.generationFailed");
                    setNodes((current) => {
                        const updated = current.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, images: item.metadata?.images?.map((image) => image.id === pendingImage.id ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image) } } : item);
                        return updated.map((item) => {
                            if (item.type !== CanvasNodeType.Config || item.metadata?.status !== NODE_STATUS_LOADING) return item;
                            const children = connections.filter((connection) => connection.fromNodeId === item.id).map((connection) => updated.find((child) => child.id === connection.toNodeId)).filter((child): child is CanvasNodeData => child?.type === CanvasNodeType.Image);
                            if (!children.length) return item;
                            const failed = children.some((child) => child.metadata?.images?.some((image) => image.status === NODE_STATUS_ERROR));
                            const pending = children.some((child) => child.metadata?.images?.some((image) => image.status === NODE_STATUS_LOADING));
                            return { ...item, metadata: { ...item.metadata, status: pending ? NODE_STATUS_LOADING : failed ? NODE_STATUS_ERROR : NODE_STATUS_SUCCESS, errorDetails: failed ? errorDetails : undefined } };
                        });
                    });
                    return;
                }
                if (task.status === "reviewing" || task.status === "queued" || task.status === "running") return;
                if (task.status !== "succeeded" || !task.image) {
                    setNodes((current) => {
                        const updated = current.map((item) => {
                            if (item.id !== nodeId) return item;
                            const currentImage = item.metadata?.images?.find((image) => image.id === pendingImage.id);
                            if (currentImage?.generationBatchId !== batchId || (currentImage.generationTaskId && currentImage.generationTaskId !== task.id)) return item;
                            const errorDetails = task.errorMessage || t("canvas.projectPage.generationFailed");
                            const images = item.metadata?.images?.map((image) => image.id === pendingImage.id ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image);
                            return { ...item, metadata: { ...item.metadata, images, status: images?.some((image) => image.status === NODE_STATUS_LOADING) ? NODE_STATUS_LOADING : images?.some((image) => image.status === NODE_STATUS_SUCCESS) ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails } };
                        });
                        return updated.map((item) => {
                            if (item.type !== CanvasNodeType.Config || item.metadata?.status !== NODE_STATUS_LOADING) return item;
                            const children = connections.filter((connection) => connection.fromNodeId === item.id).map((connection) => updated.find((child) => child.id === connection.toNodeId)).filter((child): child is CanvasNodeData => child?.type === CanvasNodeType.Image && (child.id === nodeId || Boolean(child.metadata?.images?.some((image) => image.generationBatchId))));
                            if (!children.length) return item;
                            const failed = children.some((child) => child.metadata?.images?.some((image) => image.status === NODE_STATUS_ERROR));
                            const pending = children.some((child) => child.metadata?.images?.some((image) => image.status === NODE_STATUS_LOADING));
                            return { ...item, metadata: { ...item.metadata, status: pending ? NODE_STATUS_LOADING : failed ? NODE_STATUS_ERROR : NODE_STATUS_SUCCESS, errorDetails: failed ? item.metadata?.errorDetails : undefined } };
                        });
                    });
                    return;
                }
                const stored = {
                    url: task.image.url,
                    storageKey: `image:${task.image.mediaId}`,
                    width: task.image.width || 1,
                    height: task.image.height || 1,
                    bytes: task.image.bytes || 0,
                    mimeType: task.image.mimeType || "image/png",
                };
                if (disposed) return;
                setNodes((current) => {
                    const updated = current.map((item) => {
                        if (item.id !== nodeId) return item;
                        const metadata = item.metadata;
                        const currentImage = metadata?.images?.find((image) => image.id === pendingImage.id);
                        if (!metadata || currentImage?.generationBatchId !== batchId || (currentImage.generationTaskId && currentImage.generationTaskId !== task.id)) return item;
                        const imageSize = fitNodeSize(stored.width, stored.height, item.width, item.height);
                        const image: CanvasNodeImage = { id: pendingImage.id, status: NODE_STATUS_SUCCESS, content: stored.url, storageKey: stored.storageKey, naturalWidth: stored.width, naturalHeight: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
                        const images = metadata.images?.map((entry) => (entry.id === pendingImage.id ? image : entry)) || [image];
                        const isPrimary = !metadata.primaryImageId;
                        return { ...item, ...(isPrimary ? imageSize : {}), metadata: { ...metadata, content: metadata.content || image.content, storageKey: metadata.storageKey || image.storageKey, naturalWidth: metadata.naturalWidth || image.naturalWidth, naturalHeight: metadata.naturalHeight || image.naturalHeight, bytes: metadata.bytes || image.bytes, mimeType: metadata.mimeType || image.mimeType, images, primaryImageId: metadata.primaryImageId || image.id, status: images.some((entry) => entry.status === NODE_STATUS_LOADING) ? NODE_STATUS_LOADING : NODE_STATUS_SUCCESS, errorDetails: undefined } };
                    });
                    return updated.map((item) => {
                        if (item.type !== CanvasNodeType.Config || item.metadata?.status !== NODE_STATUS_LOADING) return item;
                        const children = connections.filter((connection) => connection.fromNodeId === item.id).map((connection) => updated.find((child) => child.id === connection.toNodeId)).filter((child): child is CanvasNodeData => child?.type === CanvasNodeType.Image && (child.id === nodeId || Boolean(child.metadata?.images?.some((image) => image.generationBatchId))));
                        if (!children.length) return item;
                        const failed = children.some((child) => child.metadata?.images?.some((image) => image.status === NODE_STATUS_ERROR));
                        const pending = children.some((child) => child.metadata?.images?.some((image) => image.status === NODE_STATUS_LOADING));
                        return { ...item, metadata: { ...item.metadata, status: pending ? NODE_STATUS_LOADING : failed ? NODE_STATUS_ERROR : NODE_STATUS_SUCCESS, errorDetails: failed ? item.metadata?.errorDetails : undefined } };
                    });
                });
            } catch {
                // Keep the persisted batch marker so a later poll can retry recovery.
            } finally {
                restoringGenerationImagesRef.current.delete(restoreKey);
            }
        };
        const pollPending = () => pending.forEach(({ nodeId, image }) => void pollPendingImage(nodeId, image));
        pollPending();
        const timer = window.setInterval(pollPending, 1800);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [pendingImageKey, connections, projectLoaded, setNodes, t]);

    useEffect(() => {
        if (!projectLoaded) return;
        const pending = pendingTextRef.current;
        if (!pending.length) return;
        const applyTextDetail = (nodeId: string, requestId: string, detail: TextRequestDetail) => {
            missingTextRequestsRef.current.delete(requestId);
            if (detail.request.status !== "succeeded" && detail.request.status !== "failed" && detail.request.status !== "canceled") {
                if (detail.request.partialText) setNodes((current) => {
                    const node = current.find((item) => item.id === nodeId);
                    if (!node) return current;
                    const updated = applyTextGenerationProgress(node, requestId, detail.request.partialText!);
                    return updated === node ? current : current.map((item) => item.id === nodeId ? updated : item);
                });
                return;
            }
            setNodes((current) => {
                const updated = current.map((node) => {
                    if (node.id !== nodeId) return node;
                    if (detail.request.status === "succeeded" && detail.message) return applyTextGenerationResult(node, requestId, { content: detail.message.content, status: NODE_STATUS_SUCCESS, errorDetails: undefined });
                    const errorDetails = detail.request.errorCode ? `文本请求失败：${detail.request.errorCode}` : t("canvas.projectPage.generationFailed");
                    return applyTextGenerationResult(node, requestId, { content: "", status: NODE_STATUS_ERROR, errorDetails });
                });
                const parentIds = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
                return updated.map((node) => {
                    if (!parentIds.includes(node.id) || node.type !== CanvasNodeType.Config || node.metadata?.status !== NODE_STATUS_LOADING) return node;
                    const children = connections.filter((connection) => connection.fromNodeId === node.id).map((connection) => updated.find((child) => child.id === connection.toNodeId)).filter((child): child is CanvasNodeData => Boolean(child) && (hasTextGenerationRequest(child!) || child?.type === CanvasNodeType.Text && child.metadata?.status === NODE_STATUS_ERROR));
                    if (!children.length || children.some((child) => child.metadata?.status === NODE_STATUS_LOADING)) return node;
                    const failed = children.find((child) => child.metadata?.status === NODE_STATUS_ERROR);
                    return { ...node, metadata: { ...node.metadata, status: failed ? NODE_STATUS_ERROR : NODE_STATUS_SUCCESS, errorDetails: failed?.metadata?.errorDetails } };
                });
            });
        };
        const markTextInterrupted = (nodeId: string, requestId: string) => {
            setNodes((current) => {
                const updated = current.map((node) =>
                    node.id === nodeId
                        ? applyTextGenerationResult(node, requestId, { content: "", status: NODE_STATUS_ERROR, errorDetails: t("canvas.generation.interrupted") })
                        : node,
                );
                const parentIds = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
                return updated.map((node) => {
                    if (!parentIds.includes(node.id) || node.type !== CanvasNodeType.Config || node.metadata?.status !== NODE_STATUS_LOADING) return node;
                    const children = connections.filter((connection) => connection.fromNodeId === node.id).map((connection) => updated.find((child) => child.id === connection.toNodeId)).filter((child): child is CanvasNodeData => Boolean(child) && (hasTextGenerationRequest(child!) || child?.type === CanvasNodeType.Text && child.metadata?.status === NODE_STATUS_ERROR));
                    if (!children.length || children.some((child) => child.metadata?.status === NODE_STATUS_LOADING)) return node;
                    const failed = children.find((child) => child.metadata?.status === NODE_STATUS_ERROR);
                    return { ...node, metadata: { ...node.metadata, status: failed ? NODE_STATUS_ERROR : NODE_STATUS_SUCCESS, errorDetails: failed?.metadata?.errorDetails } };
                });
            });
        };
        // 文本恢复走已有 SSE；请求暂时不可读时沿用原来的三次容忍，之后标记为已中断。
        const cleanups = pending.map(({ nodeId, requestId }) => {
            let cleanup = () => {};
            const subscribe = () => {
                cleanup = watchTextRequest(requestId, (detail) => applyTextDetail(nodeId, requestId, detail), undefined, (error) => {
                    if (!(error instanceof ApiError) || error.status !== 404) return;
                    const misses = (missingTextRequestsRef.current.get(requestId) || 0) + 1;
                    missingTextRequestsRef.current.set(requestId, misses);
                    if (misses < 3) {
                        subscribe();
                        return;
                    }
                    missingTextRequestsRef.current.delete(requestId);
                    markTextInterrupted(nodeId, requestId);
                });
            };
            subscribe();
            return () => cleanup();
        });
        return () => cleanups.forEach((cleanup) => cleanup());
    }, [pendingTextKey, connections, projectLoaded, setNodes, t]);

    useEffect(() => {
        if (!projectLoaded) return;
        let changed = false;
        const nextNodes = nodes.map((node) => {
            if (node.type !== CanvasNodeType.Config || (node.metadata?.status !== NODE_STATUS_LOADING && node.metadata?.status !== NODE_STATUS_IDLE)) return node;
            const children = connections
                .filter((connection) => connection.fromNodeId === node.id)
                .map((connection) => nodes.find((child) => child.id === connection.toNodeId))
                .filter((child): child is CanvasNodeData => Boolean(child) && (hasTextGenerationRequest(child!) || child?.type === CanvasNodeType.Text && child.metadata?.status === NODE_STATUS_ERROR));
            if (!children.length) return node;
            const failed = children.find((child) => child.metadata?.status === NODE_STATUS_ERROR);
            const nextStatus = children.some((child) => child.metadata?.status === NODE_STATUS_LOADING) ? NODE_STATUS_LOADING : failed ? NODE_STATUS_ERROR : NODE_STATUS_SUCCESS;
            if (node.metadata?.status === nextStatus && node.metadata?.errorDetails === failed?.metadata?.errorDetails) return node;
            changed = true;
            return { ...node, metadata: { ...node.metadata, status: nextStatus, errorDetails: failed?.metadata?.errorDetails } };
        });
        if (changed) setNodes(nextNodes);
    }, [connections, nodes, projectLoaded, setNodes]);
}
