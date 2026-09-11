import { apiRequest } from "@/services/api/request";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
export { uploadMedia as uploadGenerationMedia } from "@/services/api/media";

export type PublicModel = {
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
    status: "queued" | "running" | "succeeded" | "failed" | "canceled";
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

export async function deleteGenerationBatch(id: string) {
    await apiRequest<void>(`/api/generation-batches/${id}`, { method: "DELETE" });
}

export async function retryGenerationTask(taskId: string) {
    return (await apiRequest<{ task: GenerationTask }>(`/api/generation-batches/tasks/${taskId}/retry`, { method: "POST" })).task;
}
