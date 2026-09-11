import { apiRequest, ApiError } from "@/services/api/request";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type MediaRecord = {
    id: string;
    originalName: string;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    createdAt: string;
    url: string;
};

export type StorageUsage = { totalCount: number; totalBytes: number; quotaBytes: number };

export async function getMyStorageUsage() {
    const stats = await apiRequest<StorageUsage>("/api/media/stats");
    return { totalCount: Number(stats.totalCount), totalBytes: Number(stats.totalBytes), quotaBytes: Number(stats.quotaBytes || 0) };
}

export function mediaId(storageKey: string) {
    return storageKey.replace(/^(?:image|media):/, "");
}

export async function uploadMedia(file: Blob, fileName = "image.png") {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const body = new FormData();
    body.set("file", file, fileName);
    const response = await fetch("/api/media", { method: "POST", body, credentials: "include" });
    assertCurrentSession(sessionVersion);
    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        assertCurrentSession(sessionVersion);
        if (response.status === 401) window.dispatchEvent(new Event("auth:unauthorized"));
        if (payload?.error === "password_change_required") window.dispatchEvent(new Event("auth:password-change-required"));
        throw new ApiError(payload?.message || `请求失败（HTTP ${response.status}）`, response.status, payload?.error);
    }
    const result = (await response.json()) as { media: MediaRecord };
    assertCurrentSession(sessionVersion);
    return result.media;
}

export function mediaUrl(id: string) {
    return `/api/media/${mediaId(id)}`;
}

export async function readMedia(id: string) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const response = await fetch(mediaUrl(id), { credentials: "include", cache: "no-cache" });
    assertCurrentSession(sessionVersion);
    if (response.status === 401) window.dispatchEvent(new Event("auth:unauthorized"));
    if (!response.ok) throw new ApiError(`读取文件失败（HTTP ${response.status}）`, response.status);
    const result = await response.blob();
    assertCurrentSession(sessionVersion);
    return result;
}

export async function deleteMedia(id: string) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const response = await fetch(mediaUrl(id), { method: "DELETE", credentials: "include" });
    assertCurrentSession(sessionVersion);
    if (response.status === 204 || response.status === 404 || response.status === 409) return;
    throw new ApiError(`删除文件失败（HTTP ${response.status}）`, response.status);
}
