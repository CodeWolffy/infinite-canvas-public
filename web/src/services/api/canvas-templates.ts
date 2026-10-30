import { apiRequest } from "@/services/api/request";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";

export type CanvasTemplate = {
    id: string;
    title: string;
    description: string;
    nodeCount: number;
    connectionCount: number;
    createdAt: string;
    updatedAt: string;
};

export async function listCanvasTemplates() {
    return (await apiRequest<{ templates: CanvasTemplate[] }>("/api/canvas-templates")).templates;
}

export async function listCanvasTemplatePage(offset = 0, keyword = "") {
    const params = new URLSearchParams({ offset: String(offset) });
    if (keyword.trim()) params.set("keyword", keyword.trim());
    return await apiRequest<{ templates: CanvasTemplate[]; total: number }>(`/api/canvas-templates?${params}`);
}

export async function applyCanvasTemplate(id: string) {
    return (await apiRequest<{ project: CanvasProjectDetail }>(`/api/canvas-templates/${id}/use`, { method: "POST" })).project;
}
export const useCanvasTemplate = applyCanvasTemplate;

export async function listAdminCanvasTemplates() {
    return (await apiRequest<{ templates: CanvasTemplate[] }>("/api/admin/canvas-templates")).templates;
}

export async function createCanvasTemplate(input: { title: string; description?: string; projectId: string }) {
    return (await apiRequest<{ template: CanvasTemplate }>("/api/admin/canvas-templates", { method: "POST", body: input })).template;
}

export async function updateCanvasTemplate(id: string, input: { title: string; description?: string }) {
    return (await apiRequest<{ template: CanvasTemplate }>(`/api/admin/canvas-templates/${id}`, { method: "PUT", body: input })).template;
}

export async function deleteCanvasTemplate(id: string) {
    await apiRequest<void>(`/api/admin/canvas-templates/${id}`, { method: "DELETE" });
}
