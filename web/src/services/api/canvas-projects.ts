import { apiRequest } from "@/services/api/request";

/** 列表只下发元数据、已授权封面与规模统计，完整快照由详情接口读取。 */
export type CanvasProjectSummary = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    revision: number;
    nodeCount: number;
    connectionCount: number;
    coverUrl?: string | null;
    previewType?: string | null;
    /** 当前用户的有效角色：owner/editor/viewer；viewer 只能读不能写。 */
    accessRole?: "owner" | "editor" | "viewer" | "";
    workspaceId?: string | null;
    workspaceName?: string | null;
    /** 只有画布所有者或工作区所有者能删除。 */
    canDelete?: boolean;
};

export type CanvasProjectDetail = CanvasProjectSummary & { snapshot: unknown };

export type CanvasProjectQuery = {
    keyword?: string;
    workspaceId?: string;
    sort?: "updated_desc" | "created_desc" | "created_asc" | "title_asc";
};

export async function listCanvasProjects(offset = 0, query: CanvasProjectQuery = {}) {
    const params = new URLSearchParams({ offset: String(offset) });
    if (query.keyword?.trim()) params.set("keyword", query.keyword.trim());
    if (query.workspaceId) params.set("workspaceId", query.workspaceId);
    if (query.sort) params.set("sort", query.sort);
    return await apiRequest<{ projects: CanvasProjectSummary[]; total: number }>(`/api/canvas-projects?${params}`);
}

export async function getCanvasProject(id: string) {
    return (await apiRequest<{ project: CanvasProjectDetail }>(`/api/canvas-projects/${id}`)).project;
}

export async function createCanvasProject(input: { title: string; snapshot: unknown; workspaceId?: string }) {
    return (await apiRequest<{ project: CanvasProjectDetail }>("/api/canvas-projects", { method: "POST", body: input })).project;
}

let onWorkspaceMove: (record: CanvasProjectSummary) => void = () => {};

export function onCanvasWorkspaceMove(listener: (record: CanvasProjectSummary) => void) {
    onWorkspaceMove = listener;
}

export async function updateCanvasProject(id: string, input: { title?: string; snapshot?: unknown; viewport?: unknown; workspaceId?: string | null; expectedRevision?: number }) {
    const record = (await apiRequest<{ project: CanvasProjectSummary }>(`/api/canvas-projects/${id}`, { method: "PUT", body: input })).project;
    if (input.workspaceId !== undefined && input.title === undefined && input.snapshot === undefined && input.viewport === undefined) onWorkspaceMove(record);
    return record;
}

export async function deleteCanvasProject(id: string) {
    await apiRequest<void>(`/api/canvas-projects/${id}`, { method: "DELETE" });
}

export type CanvasProjectHistoryRecord = {
    id: string;
    title: string;
    note?: string | null;
    createdAt: string;
    nodeCount: number;
    connectionCount: number;
};

export async function listCanvasProjectHistory(id: string) {
    return (await apiRequest<{ history: CanvasProjectHistoryRecord[] }>(`/api/canvas-projects/${id}/history`)).history;
}

export async function createCanvasProjectSnapshot(id: string, note?: string) {
    return (await apiRequest<{ history: CanvasProjectHistoryRecord }>(`/api/canvas-projects/${id}/history`, { method: "POST", body: { note } })).history;
}

export async function restoreCanvasProjectHistory(id: string, historyId: string) {
    return (await apiRequest<{ project: CanvasProjectDetail }>(`/api/canvas-projects/${id}/history/${historyId}/restore`, { method: "POST" })).project;
}

