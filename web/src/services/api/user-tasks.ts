import { GENERATION_PAGE_SIZE, type GenerationTask } from "./generation";
import { apiRequest, serializeApiParams } from "./request";

export type UserTaskCapability = NonNullable<GenerationTask["capability"]>;
export type UserTaskStatus = GenerationTask["status"];
export type UserGenerationTask = Omit<GenerationTask, "batchId" | "capability"> & {
    capability: UserTaskCapability;
    batchId: string | null;
    canvasProjectId: string | null;
    conversationId: string | null;
    prompt: string | null;
    sourceTitle: string | null;
    sourceUnavailable: "canvas" | "conversation" | null;
};

export type UserGenerationTaskPage = { tasks: UserGenerationTask[]; total: number; limit: number; offset: number; summary: { reviewing: number; queued: number; running: number } };

export function getUserGenerationTasks({ capability = "", status = "", offset = 0, limit = GENERATION_PAGE_SIZE }: { capability?: UserTaskCapability | ""; status?: UserTaskStatus | ""; offset?: number; limit?: number } = {}, signal?: AbortSignal) {
    return apiRequest<UserGenerationTaskPage>(`/api/generation-tasks?${serializeApiParams({ capability, status, limit, offset })}`, { signal });
}

export function getUserTaskSourcePath(task: UserGenerationTask) {
    if (task.sourceUnavailable) return null;
    if (task.canvasProjectId) return `/canvas/${encodeURIComponent(task.canvasProjectId)}`;
    if (task.capability === "text" && task.conversationId) return `/text?${serializeApiParams({ conversation: task.conversationId })}`;
    if ((task.capability === "image" || task.capability === "video") && task.batchId) return `/${task.capability}?${serializeApiParams({ batch: task.batchId })}`;
    return null;
}
