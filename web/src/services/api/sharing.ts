import { apiRequest } from "@/services/api/request";

export type ShareKind = "canvas" | "asset";

export type ShareLink = {
    token: string;
    url: string;
    createdAt: string;
};

export type SharedCanvas = {
    id: string;
    title: string;
    snapshot: unknown;
    createdAt: string;
    updatedAt: string;
    ownerName?: string | null;
};

export type SharedAsset = {
    id: string;
    type: "image" | "text" | "video" | "audio";
    title: string;
    content: string | null;
    mediaId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
    ownerName?: string | null;
};

export type SharedResource = { kind: "canvas"; canvas: SharedCanvas } | { kind: "asset"; asset: SharedAsset };

function sharePath(kind: ShareKind) {
    return kind === "canvas" ? "canvas-projects" : "assets";
}

export function getShareLink(kind: ShareKind, id: string) {
    return apiRequest<{ share: ShareLink | null }>(`/api/${sharePath(kind)}/${id}/share`);
}

export function createShareLink(kind: ShareKind, id: string) {
    return apiRequest<{ share: ShareLink }>(`/api/${sharePath(kind)}/${id}/share`, { method: "POST" });
}

export function revokeShareLink(kind: ShareKind, id: string) {
    return apiRequest<void>(`/api/${sharePath(kind)}/${id}/share`, { method: "DELETE" });
}

/** 公开只读访问：不需要登录态，token 即权限。 */
export function getSharedResource(token: string) {
    return apiRequest<SharedResource>(`/api/shared/${token}`);
}

/** 分享内容里的媒体文件必须走分享通道，匿名访客没有 /api/media 的登录态。 */
export function sharedMediaUrl(token: string, mediaId: string) {
    return `/api/shared/${token}/media/${mediaId}`;
}

export function sharePageUrl(token: string) {
    return `${window.location.origin}/s/${token}`;
}
