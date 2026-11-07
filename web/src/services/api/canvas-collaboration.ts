import { apiRequest } from "@/services/api/request";
import type { ShareLink, SharingUser } from "@/services/api/sharing";

export type CanvasMemberRole = "editor" | "viewer";
export type CanvasMember = SharingUser & {
    role: "owner" | CanvasMemberRole;
    source: "owner" | "workspace" | "direct";
    status: "pending" | "accepted";
    invitedBy?: SharingUser | null;
};
export type CanvasCollaboration = {
    owner: SharingUser;
    canManage: boolean;
    workspace: { id: string; name: string } | null;
    members: CanvasMember[];
    share: ShareLink | null;
};
export type CanvasInvitation = {
    projectId: string;
    title: string;
    invitedBy: SharingUser | null;
    role: CanvasMemberRole;
    createdAt: string;
};
export type CanvasAccessLog = { id: string; action: string; createdAt: string; actor: SharingUser | null };

export function getCanvasCollaboration(id: string) {
    return apiRequest<CanvasCollaboration>(`/api/canvas-projects/${id}/collaboration`);
}

export function inviteCanvasMember(id: string, username: string, role: CanvasMemberRole = "viewer") {
    return apiRequest<void>(`/api/canvas-projects/${id}/members`, { method: "POST", body: { username, role } });
}

export function updateCanvasMember(id: string, userId: string, role: CanvasMemberRole) {
    return apiRequest<void>(`/api/canvas-projects/${id}/members/${userId}`, { method: "PATCH", body: { role } });
}

export function removeCanvasMember(id: string, userId: string) {
    return apiRequest<void>(`/api/canvas-projects/${id}/members/${userId}`, { method: "DELETE" });
}

export async function listCanvasInvitations() {
    return (await apiRequest<{ invitations: CanvasInvitation[] }>("/api/canvas-invitations")).invitations;
}

export function respondCanvasInvitation(id: string, accept: boolean) {
    return apiRequest<void>(`/api/canvas-projects/${id}/invitation`, { method: "POST", body: { accept } });
}

export function getCanvasAccessLog(id: string, offset = 0) {
    return apiRequest<{ items: CanvasAccessLog[]; total: number }>(`/api/canvas-projects/${id}/access-log?offset=${offset}`);
}
