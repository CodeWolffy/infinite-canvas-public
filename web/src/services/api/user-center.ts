import { apiRequest } from "./request";
import type { AuthUser } from "@/services/api/auth";

export type UserStats = {
    video: { total: number; succeeded: number; failed: number; active: number };
    audio: { total: number; succeeded: number; failed: number; active: number };
    images: {
        total: number;
        succeeded: number;
        failed: number;
        active: number;
    };
    text: {
        total: number;
        succeeded: number;
        failed: number;
    };
    storage: {
        totalCount: number;
        totalBytes: number;
        quotaBytes?: number;
    };
    canvasCount: number;
    assetCount: number;
    spent?: string;
    recharge?: string;
    grants?: string;
    checkin?: string;
    adjustment?: string;
};

export type UserRequestLog = {
    id: string;
    type: "image" | "text" | "video" | "audio" | "probe";
    taskId: string | null;
    textRequestId: string | null;
    modelDisplayName: string | null;
    status: "running" | "succeeded" | "failed";
    httpStatus: number | null;
    errorCategory: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
};

export type UserLogsQuery = {
    from?: string;
    to?: string;
    type?: "image" | "text" | "video" | "audio" | "probe";
    status?: "running" | "succeeded" | "failed";
    limit?: number;
    offset?: number;
};

export type UserLogsResult = {
    logs: UserRequestLog[];
    total: number;
    limit: number;
    offset: number;
};

export async function getUserStats() {
    return (await apiRequest<{ stats: UserStats }>("/api/user/stats")).stats;
}

export async function getUserLogs(params: UserLogsQuery = {}) {
    const searchParams = new URLSearchParams();
    if (params.from) searchParams.set("from", params.from);
    if (params.to) searchParams.set("to", params.to);
    if (params.type) searchParams.set("type", params.type);
    if (params.status) searchParams.set("status", params.status);
    if (params.limit !== undefined) searchParams.set("limit", String(params.limit));
    if (params.offset !== undefined) searchParams.set("offset", String(params.offset));

    const qs = searchParams.toString();
    return apiRequest<UserLogsResult>(`/api/user/logs${qs ? `?${qs}` : ""}`);
}

export async function updateUserProfile(payload: { displayName: string }) {
    return (await apiRequest<{ user: AuthUser }>("/api/user/profile", {
        method: "PATCH",
        body: payload,
    })).user;
}
