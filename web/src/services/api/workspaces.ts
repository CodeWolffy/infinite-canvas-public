import { apiRequest } from "@/services/api/request";
import type { AssetRecord } from "@/services/api/assets";
import type { CanvasProjectSummary } from "@/services/api/canvas-projects";

export type WorkspaceRole = "owner" | "editor" | "viewer";

export type Workspace = {
    id: string;
    name: string;
    ownerId: string;
    myRole?: WorkspaceRole;
    memberCount?: number;
    projectCount?: number;
    assetCount?: number;
    createdAt: string;
};

export type WorkspaceMember = {
    userId: string;
    role: WorkspaceRole;
    username?: string;
    displayName?: string;
    createdAt: string;
};

export type WorkspaceDetail = {
    workspace: Workspace;
    members: WorkspaceMember[];
    projects: (CanvasProjectSummary & { ownerName?: string | null })[];
    assets: (AssetRecord & { ownerName?: string | null })[];
};

export async function listWorkspaces() {
    return (await apiRequest<{ workspaces: Workspace[] }>("/api/workspaces")).workspaces;
}

export async function createWorkspace(name: string) {
    return (await apiRequest<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: { name } })).workspace;
}

export async function getWorkspace(id: string) {
    return await apiRequest<WorkspaceDetail>(`/api/workspaces/${id}`);
}

export async function updateWorkspace(id: string, name: string) {
    return (await apiRequest<{ workspace: Workspace }>(`/api/workspaces/${id}`, { method: "PUT", body: { name } })).workspace;
}

export async function deleteWorkspace(id: string) {
    await apiRequest<void>(`/api/workspaces/${id}`, { method: "DELETE" });
}

export async function addWorkspaceMember(id: string, username: string, role: Exclude<WorkspaceRole, "owner">) {
    return (await apiRequest<{ member: WorkspaceMember }>(`/api/workspaces/${id}/members`, { method: "POST", body: { username, role } })).member;
}

export async function updateWorkspaceMember(id: string, userId: string, role: Exclude<WorkspaceRole, "owner">) {
    return (await apiRequest<{ member: WorkspaceMember }>(`/api/workspaces/${id}/members/${userId}`, { method: "PATCH", body: { role } })).member;
}

export async function removeWorkspaceMember(id: string, userId: string) {
    await apiRequest<void>(`/api/workspaces/${id}/members/${userId}`, { method: "DELETE" });
}
