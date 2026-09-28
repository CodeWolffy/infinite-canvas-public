import { ApiError, apiRequest } from "@/services/api/request";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { ModelReasoning } from "@/lib/model-reasoning";
export { uploadMedia as uploadGenerationMedia } from "@/services/api/media";

export type PublicModel = ModelReasoning & {
    id: string;
    name: string;
    displayName: string;
    capability: "image" | "text" | "video" | "audio";
    price?: string;
    pricePerImage?: string | null;
    inputPricePerMillion?: string | null;
    cachedPricePerMillion?: string | null;
    outputPricePerMillion?: string | null;
    pricePerSecond?: string | null;
    groupDiscount?: string;
    sortOrder: number;
    description: string | null;
    imageInput?: boolean;
};

export type GenerationBatch = {
    capability?: "image" | "video" | "audio";
    id: string;
    canvasProjectId: string | null;
    modelId: string;
    prompt: string;
    requestedCount: number;
    parameters: Record<string, unknown>;
    createdAt: string;
    retentionDays?: number;
};

export type GenerationTask = {
    capability?: "image" | "text" | "video" | "audio";
    price?: string;
    billed?: string;
    output?: { mediaId: string; url: string; mimeType: string; bytes: number; width?: number | null; height?: number | null };
    id: string;
    batchId: string;
    status: "reviewing" | "queued" | "running" | "succeeded" | "failed" | "canceled";
    attemptCount?: number;
    maxAttempts?: number;
    sequence: number;
    errorCode: string | null;
    errorMessage: string | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    modelName: string | null;
    modelDisplayName: string | null;
    image?: { mediaId: string; url: string; mimeType?: string; bytes?: number; width?: number | null; height?: number | null; isSaved?: boolean };
};

export type GenerationBatchDetail = { batch: GenerationBatch; tasks: GenerationTask[]; referenceMediaIds: string[] };

export type GenerationBatchSummary = {
    totalCount: number;
    succeededCount: number;
    failedCount: number;
    activeCount: number;
    savedCount: number;
    thumbnailMediaIds: string[];
};

export type GenerationBatchListItem = GenerationBatch & { summary: GenerationBatchSummary };

export type GenerationBatchPage = { batches: GenerationBatchListItem[]; hasMore: boolean };

/** 服务端单页上限 100，永远不要一次把用户的全部生图历史拉下来。 */
export const GENERATION_PAGE_SIZE = 50;

const publicModelsCacheTtl = 60_000;
let publicModelsCache: { models: PublicModel[]; expiresAt: number } | null = null;
useUserStore.subscribe((state, previous) => { if (state.sessionVersion !== previous.sessionVersion) publicModelsCache = null; });

export function clearPublicModelsCache() {
    publicModelsCache = null;
}

export async function getPublicModels() {
    const session = useUserStore.getState().sessionVersion;
    if (!publicModelsCache || publicModelsCache.expiresAt <= Date.now()) {
        const { models } = await apiRequest<{ models: PublicModel[] }>("/api/models");
        assertCurrentSession(session);
        publicModelsCache = { models, expiresAt: Date.now() + publicModelsCacheTtl };
    }
    return publicModelsCache.models;
}

export async function getGenerationPreferences() {
    return (await apiRequest<{ preferences: Record<string, unknown> }>("/api/preferences")).preferences;
}

export async function updateGenerationPreferences(preferences: Record<string, unknown>) {
    return (await apiRequest<{ preferences: Record<string, unknown> }>("/api/preferences", { method: "PUT", body: preferences })).preferences;
}

export async function createGenerationBatch(input: { requestId?: string; modelId: string; prompt: string; count: number; parameters: Record<string, unknown>; referenceMediaIds: string[]; canvasProjectId?: string }) {
    return await apiRequest<{ batch: GenerationBatch; tasks: GenerationTask[] }>("/api/generation-batches", { method: "POST", body: { ...input, requestId: input.requestId || crypto.randomUUID() } });
}

export async function listGenerationBatches(limit = GENERATION_PAGE_SIZE, offset = 0): Promise<GenerationBatchPage> {
    const batches = (await apiRequest<{ batches: GenerationBatchListItem[] }>(`/api/generation-batches?capability=image&limit=${limit}&offset=${offset}`)).batches;
    return { batches, hasMore: batches.length === limit };
}

export async function getGenerationBatch(id: string) {
    return await apiRequest<GenerationBatchDetail>(`/api/generation-batches/${id}`);
}

/**
 * 批次级 SSE：服务端在任务状态变化时推送完整快照，全部任务进入终态后主动关闭连接。
 * 连接中断时退化为短间隔轮询兜底，与文本流的 watchTextRequest 同一模式。
 */
export function watchGenerationBatch(id: string, onSnapshot: (detail: GenerationBatchDetail) => void, signal?: AbortSignal, onError?: (error: Error) => void) {
    const session = useUserStore.getState().sessionVersion;
    const controller = new AbortController();
    let closed = false;
    let polling = false;
    let source: EventSource | null = null;
    let unsubscribe = () => {};
    const cleanup = () => { if (closed) return; closed = true; source?.close(); controller.abort(); unsubscribe(); signal?.removeEventListener("abort", aborted); };
    const fail = (error: Error) => { cleanup(); onError?.(error); };
    const aborted = () => fail(new DOMException("已停止等待", "AbortError"));
    const receive = (detail: GenerationBatchDetail) => {
        if (closed) return;
        assertCurrentSession(session);
        if (detail.batch.id.toLowerCase() !== id.toLowerCase()) return;
        onSnapshot(detail);
        if (!detail.tasks.some((task) => task.status === "reviewing" || task.status === "queued" || task.status === "running")) cleanup();
    };
    const poll = async () => {
        while (!closed) {
            try { receive(await getGenerationBatch(id)); }
            catch (error) {
                if (error instanceof DOMException && error.name === "AbortError" || error instanceof ApiError && error.status < 500) { fail(error as Error); return; }
            }
            if (!closed) {
                await new Promise<void>((resolve) => {
                    const abort = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); resolve(); };
                    const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 2500);
                    if (controller.signal.aborted) abort();
                    else controller.signal.addEventListener("abort", abort, { once: true });
                });
            }
        }
    };
    unsubscribe = useUserStore.subscribe((state) => { if (state.sessionVersion !== session) aborted(); });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return cleanup; }
    source = new EventSource(`/api/generation-batches/${id}/events`, { withCredentials: true });
    source.addEventListener("snapshot", (event) => {
        try { receive(JSON.parse((event as MessageEvent<string>).data) as GenerationBatchDetail); }
        catch (error) { fail(error instanceof Error ? error : new Error("批次快照读取失败")); }
    });
    source.addEventListener("expired", () => { if (!closed && useUserStore.getState().sessionVersion === session) window.dispatchEvent(new Event("auth:unauthorized")); aborted(); });
    source.addEventListener("unavailable", () => fail(new Error("生成批次暂时不可读取，请刷新重试")));
    source.onerror = () => { if (closed || polling) return; polling = true; source?.close(); source = null; void poll(); };
    return cleanup;
}

export async function deleteGenerationBatch(id: string) {
    await apiRequest<void>(`/api/generation-batches/${id}`, { method: "DELETE" });
}

export async function retryGenerationTask(taskId: string) {
    return (await apiRequest<{ task: GenerationTask }>(`/api/generation-batches/tasks/${taskId}/retry`, { method: "POST" })).task;
}
