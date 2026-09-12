import { apiRequest, serializeApiParams } from "@/services/api/request";

export type AdminModel = {
    id: string;
    name: string;
    displayName: string;
    capability: "image" | "text" | "video" | "audio";
    price?: string;
    sortOrder: number;
    status: "draft" | "published" | "disabled";
    pricePerImage: string | null;
    inputPricePerMillion?: string | null;
    cachedPricePerMillion?: string | null;
    outputPricePerMillion?: string | null;
    pricePerSecond?: string | null;
    description: string | null;
    config: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
};

export type AdminChannel = {
    id: string;
    name: string;
    protocol: "openai" | "gemini" | "anthropic";
    baseUrl: string;
    status: "active" | "disabled" | "needs_attention";
    timeoutMs: number;
    maxConcurrency: number;
    cooldownSeconds: number;
    apiKeyConfigured: boolean;
    keyCount: number;
    activeKeyCount: number;
    keyStrategy: "round_robin" | "random";
    taskAdapter: string;
    autoDisabledAt: string | null;
    consecutiveCheckFailures: number;
    latency?: { samples: number; p50Ms: number | null; p95Ms: number | null };
    cooldownUntil: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorCode: string | null;
    monitoring?: import("./platform-operations").MonitoringConfig;
    monitorStatus?: string | null;
    monitorError?: string | null;
    monitorCheckedAt?: string | null;
    monitorToken?: string | null;
    nextCheckAt?: string | null;
    modelChanges?: { added: string[]; removed: string[] } | null;
    upstreamModels?: string[];
    upstreamBalance?: string | null;
    balanceStatus?: string | null;
    lastAttempt?: {
        status: "running" | "succeeded" | "failed";
        durationMs: number | null;
        httpStatus: number | null;
        errorCategory: string | null;
        errorMessage: string | null;
        upstreamModel: string;
        startedAt: string;
        finishedAt: string | null;
    } | null;
    createdAt: string;
    updatedAt: string;
};

export type ModelChannelBinding = {
    id: string;
    costConfig?: import("./platform-operations").CostConfig;
    modelId: string;
    channelId: string;
    channelName: string;
    channelStatus: AdminChannel["status"];
    upstreamModel: string;
    priority: number;
    weight: number;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type ModelInput = Pick<AdminModel, "name" | "displayName" | "capability" | "status"> & { sortOrder?: number; pricePerImage?: string | number | null; inputPricePerMillion?: string | null; cachedPricePerMillion?: string | null; outputPricePerMillion?: string | null; pricePerSecond?: string | null; description?: string | null; config?: Record<string, unknown> };
export type ChannelInput = Pick<AdminChannel, "name" | "protocol" | "baseUrl" | "status" | "timeoutMs" | "maxConcurrency" | "keyStrategy"> & { cooldownSeconds?: number; apiKeys?: string[]; taskAdapter?: string };
export type ChannelKey = { id: string; keyHint: string; status: "active" | "disabled"; disabledReason: string | null; lastUsedAt: string | null; lastErrorCode: string | null };
export const getChannelKeys = (id: string) => apiRequest<{ keys: ChannelKey[] }>(`/api/admin/channels/${id}/keys`);
export const setChannelKeyStatus = (id: string, keyId: string, status: ChannelKey["status"]) => apiRequest<void>(`/api/admin/channels/${id}/keys/${keyId}`, { method: "PATCH", body: { status } });
export const deleteChannelKey = (id: string, keyId: string) => apiRequest<void>(`/api/admin/channels/${id}/keys/${keyId}`, { method: "DELETE" });
export const getTaskAdapters = () => apiRequest<{ adapters: Array<{ id: string; name: string; protocol: string; capability: string }> }>("/api/admin/task-adapters");
export type BindingInput = { id?: string; upstreamModel: string; priority: number; weight: number; enabled: boolean };

export async function getAdminModels() {
    return (await apiRequest<{ models: AdminModel[] }>("/api/admin/models")).models;
}

export async function createAdminModel(input: ModelInput) {
    return (await apiRequest<{ model: AdminModel }>("/api/admin/models", { method: "POST", body: input })).model;
}

export async function updateAdminModel(id: string, input: Partial<ModelInput>) {
    return (await apiRequest<{ model: AdminModel }>(`/api/admin/models/${id}`, { method: "PUT", body: input })).model;
}

export async function updateAdminModelStatus(id: string, status: AdminModel["status"]) {
    return (await apiRequest<{ model: AdminModel }>(`/api/admin/models/${id}/status`, { method: "PATCH", body: { status } })).model;
}

export async function deleteAdminModel(id: string) {
    await apiRequest<void>(`/api/admin/models/${id}`, { method: "DELETE" });
}

export async function getModelChannelBindings(modelId: string) {
    return (await apiRequest<{ bindings: ModelChannelBinding[] }>(`/api/admin/models/${modelId}/channels`)).bindings;
}

export async function saveModelChannelBinding(modelId: string, channelId: string, input: BindingInput) {
    await apiRequest(`/api/admin/models/${modelId}/channels/${channelId}`, { method: "PUT", body: input });
}

export async function batchSaveModelChannelBindings(modelId: string, channelId: string, input: { upstreamModels: string[]; priority: number; weight: number; enabled: boolean }) {
    await apiRequest(`/api/admin/models/${modelId}/channels/${channelId}/batch`, { method: "POST", body: input });
}

export async function deleteModelBinding(modelId: string, bindingId: string) {
    await apiRequest<void>(`/api/admin/models/${modelId}/bindings/${bindingId}`, { method: "DELETE" });
}

export async function deleteModelChannelBinding(modelId: string, channelId: string) {
    await apiRequest<void>(`/api/admin/models/${modelId}/channels/${channelId}`, { method: "DELETE" });
}

export async function getAdminChannels() {
    return (await apiRequest<{ channels: AdminChannel[] }>("/api/admin/channels")).channels;
}

export async function createAdminChannel(input: ChannelInput) {
    return (await apiRequest<{ channel: AdminChannel }>("/api/admin/channels", { method: "POST", body: input })).channel;
}

export async function updateAdminChannel(id: string, input: Partial<ChannelInput>) {
    return (await apiRequest<{ channel: AdminChannel }>(`/api/admin/channels/${id}`, { method: "PUT", body: input })).channel;
}

export async function deleteAdminChannel(id: string) {
    await apiRequest<void>(`/api/admin/channels/${id}`, { method: "DELETE" });
}

export async function fetchAdminChannelModels(id: string) {
    return await apiRequest<{ models: string[]; health: { ok: true; checkedAt: string } }>(`/api/admin/channels/${id}/models`, { method: "POST" });
}

export type AdminStats = {
    range: { from: string; to: string };
    filters: { userId?: string; modelId?: string; channelId?: string };
    storage: { totalCount: number; totalBytes: number };
    queue: { queuedCount: number; runningCount: number };
    textTotals: { requestCount: number; succeededRequestCount: number; failedRequestCount: number };
    totals: { requestCount: number; succeededTaskCount: number; averageDurationMs: number; p50DurationMs: number; p95DurationMs: number; successImageCount: number; estimatedCost: string; attemptCount: number; succeededAttemptCount: number };
    byUsers: Array<{ id: string; username: string; displayName: string; requestCount: number; successImageCount: number; estimatedCost: string }>;
    byModels: Array<{ id: string; name: string; displayName: string; requestCount: number; successImageCount: number; estimatedCost: string }>;
    byChannels: Array<{ id: string; name: string; attemptCount: number; succeededAttemptCount: number; averageDurationMs: number; p50DurationMs: number; p95DurationMs: number }>;
    byDates?: Array<{ date: string; requestCount: number; succeededCount: number; failedCount: number; successImageCount: number; estimatedCost: string }>;
    byCapabilities?: Array<{ capability: string; requestCount: number; succeededCount: number; estimatedCost: string }>;
};

export async function getAdminStats(params: { from?: string; to?: string; userId?: string; modelId?: string; channelId?: string }) {
    const query = serializeApiParams(params);
    return await apiRequest<AdminStats>(`/api/admin/stats${query.size ? `?${query}` : ""}`);
}

export type RequestLog = {
    id: string;
    userId: string | null;
    username: string | null;
    userDisplayName: string | null;
    type: "image" | "text" | "video" | "audio" | "probe";
    taskId: string | null;
    textRequestId: string | null;
    modelId: string | null;
    modelNameSnapshot: string | null;
    modelDisplayNameSnapshot: string | null;
    channelId: string | null;
    channelNameSnapshot: string | null;
    upstreamModel: string | null;
    status: "running" | "succeeded" | "failed";
    httpStatus: number | null;
    errorCategory: string | null;
    errorMessage: string | null;
    billedAmount: string | null;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
};

export async function getAdminRequestLogs(params: { from?: string; to?: string; userId?: string; modelId?: string; channelId?: string; type?: RequestLog["type"]; status?: RequestLog["status"]; limit?: number; offset?: number }) {
    const query = serializeApiParams(params);
    return await apiRequest<{ logs: RequestLog[]; total: number }>(`/api/admin/request-logs${query.size ? `?${query}` : ""}`);
}

export async function clearAdminRequestLogs() {
    return (await apiRequest<{ deleted: number }>("/api/admin/request-logs", { method: "DELETE" })).deleted;
}

export type PlaygroundTestParams = {
    channelId: string;
    model: string;
    capability?: "text" | "image";
    prompt: string;
    parameters?: Record<string, unknown>;
};

export type PlaygroundTestResult = {
    ok: boolean;
    durationMs: number;
    capability?: string;
    upstreamModel?: string;
    text?: string;
    image?: string;
    outputTokens?: number;
    firstTokenMs?: number | null;
    httpStatus?: number;
    rawResponse?: unknown;
    error?: string;
    category?: string;
};

export async function testChannelPlayground(body: PlaygroundTestParams, signal?: AbortSignal) {
    return await apiRequest<PlaygroundTestResult>("/api/admin/playground/test", { method: "POST", body, signal });
}
