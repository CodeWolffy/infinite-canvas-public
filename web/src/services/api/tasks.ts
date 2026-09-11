import { apiRequest, serializeApiParams } from "./request";
import type { GenerationBatchDetail, GenerationBatchListItem, GenerationTask, PublicModel } from "./generation";
import { uploadMedia } from "./media";
import { getMediaBlob } from "@/services/file-storage";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export function getGenerationTask(id: string, signal?: AbortSignal) {
    return apiRequest<{ task: GenerationTask }>(`/api/generation-tasks/${id}`, { signal });
}
export const cancelGenerationTask = (id: string) => apiRequest<void>(`/api/generation-tasks/${id}/cancel`, { method: "POST", body: {} });
export const getCapabilityBatches = (capability: string, offset = 0) => apiRequest<{ batches: GenerationBatchListItem[] }>(`/api/generation-batches?${serializeApiParams({ capability, limit: 50, offset })}`);
export const getStudioBatch = (id: string) => apiRequest<GenerationBatchDetail>(`/api/generation-batches/${id}`);
export const getAdminTasks = (status = "", capability = "", offset = 0) => apiRequest<{ tasks: Array<GenerationTask & { username: string; modelDisplayName: string; capability: string }> }>(`/api/admin/tasks?${serializeApiParams({ status, capability, limit: 50, offset })}`);
export const cancelAdminTask = (id: string) => apiRequest<void>(`/api/admin/tasks/${id}/cancel`, { method: "POST", body: {} });

export function taskDelay(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("已停止等待", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 2500);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
    });
}

export async function waitForGenerationTask(id: string, signal?: AbortSignal) {
    const session = useUserStore.getState().sessionVersion;
    for (;;) {
        assertCurrentSession(session);
        const { task } = await getGenerationTask(id, signal);
        if (task.status === "succeeded") return task;
        if (task.status === "failed" || task.status === "canceled") throw new Error(task.errorMessage || "生成未完成，冻结余额已退回");
        await taskDelay(signal);
    }
}

export function selectedPlatformModel(models: PublicModel[], selected: string, capability: PublicModel["capability"]) {
    const id = selected.includes("::") ? selected.slice(selected.indexOf("::") + 2) : selected;
    const model = models.find((item) => item.id === id && item.capability === capability) || models.find((item) => item.capability === capability);
    if (!model) throw new Error("暂无可用模型，请联系管理员发布模型并配置渠道");
    return model.id;
}

export async function ensurePlatformMedia(reference: { storageKey?: string; url?: string; dataUrl?: string; name?: string }, signal?: AbortSignal) {
    const session = useUserStore.getState().sessionVersion;
    const serverURL = reference.url || reference.dataUrl || "";
    const urlID = serverURL.match(/^\/api\/media\/([0-9a-f-]{36})(?:$|[?#])/i)?.[1];
    const keyID = reference.storageKey?.match(/^(?:image:|media:)?([0-9a-f-]{36})$/i)?.[1];
    if (urlID || keyID) return (urlID || keyID)!;
    const blob = reference.storageKey ? await getMediaBlob(reference.storageKey) : await (await fetch(serverURL, { signal })).blob();
    assertCurrentSession(session);
    if (signal?.aborted) throw new DOMException("已停止准备", "AbortError");
    if (!blob) throw new Error("参考文件无法读取，请重新上传");
    const media = await uploadMedia(blob, reference.name || "reference");
    assertCurrentSession(session);
    return media.id;
}
