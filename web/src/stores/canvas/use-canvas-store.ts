import { create } from "zustand";
import i18n from "@/i18n";
import * as canvasApi from "@/services/api/canvas-projects";
import { ApiError } from "@/services/api/request";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** 服务端写入版本，不随本地乐观更新时间变化。 */
    revision: number;
    /** 列表接口只下发规模统计；快照要等 loadProject 拉取详情后才可用。 */
    nodeCount: number;
    connectionCount: number;
    coverUrl?: string | null;
    previewType?: string | null;
    /** 当前用户对画布的有效角色；viewer 只读，不会向服务端写回。 */
    accessRole: "owner" | "editor" | "viewer" | "";
    workspaceId: string | null;
    workspaceName: string | null;
    canDelete: boolean;
    snapshotLoaded: boolean;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasSaveError = { projectId: string; message: string; permanent: boolean; conflict?: boolean };

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    hydratedUserId: string;
    projects: CanvasProject[];
    /** 浏览列表独立于快照缓存，筛选不能丢弃尚未保存的画布。 */
    projectListIds: string[];
    projectQuery: canvasApi.CanvasProjectQuery;
    projectListLoading: boolean;
    projectListError: string;
    projectTotal: number;
    deletedProjects: CanvasDeletedProject[];
    saveError: CanvasSaveError | null;
    reloadVersion: number;
    hydrateProjects: (userId: string) => Promise<void>;
    refreshProjectList: (query?: canvasApi.CanvasProjectQuery) => Promise<void>;
    loadMoreProjects: () => Promise<void>;
    createProject: (title?: string, workspaceId?: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>) => Promise<string>;
    adoptProject: (record: canvasApi.CanvasProjectDetail) => string;
    loadProject: (id: string) => Promise<CanvasProject | null>;
    loadProjects: (ids: string[]) => Promise<CanvasProject[]>;
    renameProject: (id: string, title: string) => Promise<void>;
    deleteProjects: (ids: string[]) => Promise<void>;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
    applyRestoredProject: (record: canvasApi.CanvasProjectDetail) => void;
    flushProject: (id: string) => Promise<void>;
    retrySave: (id: string) => Promise<void>;
    hasPendingChanges: (id: string) => boolean;
    registerSnapshotCapture: (id: string, capture: () => void) => () => void;
    resolveConflict: (id: string, action: "reload" | "copy") => Promise<string>;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
type CanvasSnapshot = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">;
const emptySnapshot = (): CanvasSnapshot => ({ nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: initialViewport });
const pendingUpdates = new Map<string, ProjectUpdatePatch>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const savingProjects = new Map<string, Promise<void>>();
const deletingProjects = new Set<string>();
const hydratePromises = new Map<string, Promise<void>>();
const loadPromises = new Map<string, Promise<CanvasProject | null>>();
const snapshotCaptures = new Map<string, () => void>();
const saveAttempts = new Map<string, number>();
/** 命中不可恢复错误（如 413、400）后停止自动重试，改由用户手动重试，避免无限循环打爆接口。 */
const blockedProjects = new Set<string>();
const CANVAS_SAVE_DEBOUNCE_MS = 1000;
const MAX_SAVE_ATTEMPTS = 5;
let projectListRequestVersion = 0;

function retryDelay(attempt: number) {
    return Math.min(2000 * 2 ** (attempt - 1), 30000);
}

/** 4xx 里只有 408 / 429 值得重试，其余都是请求本身不合法，重试无意义。 */
function isPermanentFailure(error: unknown) {
    if (!(error instanceof ApiError)) return false;
    return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function projectSnapshot(project: CanvasProject): CanvasSnapshot {
    const { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport } = project;
    return { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport };
}

function accessFields(record: canvasApi.CanvasProjectSummary) {
    return {
        accessRole: record.accessRole || "owner",
        workspaceId: record.workspaceId || null,
        workspaceName: record.workspaceName || null,
        canDelete: record.canDelete !== false,
    };
}

function listProject(record: canvasApi.CanvasProjectSummary): CanvasProject {
    return {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        revision: record.revision,
        nodeCount: record.nodeCount,
        connectionCount: record.connectionCount,
        coverUrl: record.coverUrl || null,
        previewType: record.previewType || null,
        ...accessFields(record),
        snapshotLoaded: false,
        ...emptySnapshot(),
    };
}

function detailProject(record: canvasApi.CanvasProjectDetail): CanvasProject {
    const snapshot = record.snapshot && typeof record.snapshot === "object" ? (record.snapshot as Partial<CanvasSnapshot>) : {};
    const merged = { ...emptySnapshot(), ...snapshot };
    const cached = useCanvasStore.getState().projects.find((project) => project.id === record.id);
    return {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        revision: record.revision,
        nodeCount: merged.nodes.length,
        connectionCount: merged.connections.length,
        coverUrl: record.coverUrl ?? cached?.coverUrl ?? null,
        previewType: record.previewType ?? merged.nodes.find((node) => node.type !== "group")?.type ?? null,
        ...accessFields(record),
        snapshotLoaded: true,
        ...merged,
    };
}

function mergeProjectSummaries(records: canvasApi.CanvasProjectSummary[], projects: CanvasProject[]) {
    const remaining = new Map(records.map((record) => [record.id, record]));
    const cached = projects.map((project) => {
        const record = remaining.get(project.id);
        if (!record) return project;
        remaining.delete(project.id);
        if (pendingUpdates.has(project.id) || savingProjects.has(project.id) || blockedProjects.has(project.id)) return project;
        if (!project.snapshotLoaded) return listProject(record);
        // 元数据刷新不能把未重新加载的快照标记为远端新版本。
        return { ...project, title: record.title, updatedAt: record.updatedAt, coverUrl: record.coverUrl || null, previewType: record.previewType || null, ...accessFields(record) };
    });
    return [...cached, ...Array.from(remaining.values(), listProject)];
}

function mergeProject(project: CanvasProject, preserveLocal = true) {
    let next = project;
    useCanvasStore.setState((state) => ({
        projects: state.projects.some((item) => item.id === project.id)
            ? state.projects.map((current) => {
                if (current.id !== project.id) return current;
                const pending = pendingUpdates.get(project.id);
                // 迟到的详情不能覆盖本地编辑，也不能把远端新版本号套在未保存的旧快照上。
                if (preserveLocal && (pending || savingProjects.has(project.id) || current.revision > project.revision)) {
                    next = { ...project, revision: current.revision, title: current.title, updatedAt: current.updatedAt, workspaceId: current.workspaceId, workspaceName: current.workspaceName, accessRole: current.accessRole, canDelete: current.canDelete };
                    if (current.snapshotLoaded) {
                        next = { ...next, ...projectSnapshot(current), nodeCount: current.nodeCount, connectionCount: current.connectionCount };
                    } else if (pending?.snapshot) {
                        next = { ...next, ...pending.snapshot, nodeCount: pending.snapshot.nodes.length, connectionCount: pending.snapshot.connections.length };
                    } else if (pending?.viewport) {
                        next = { ...next, viewport: pending.viewport };
                    }
                }
                return next;
            })
            : [project, ...state.projects],
    }));
    return next;
}

type ProjectUpdatePatch = { title?: string; snapshot?: CanvasSnapshot; viewport?: ViewportTransform };

function mergeUpdates(previous: ProjectUpdatePatch | undefined, patch: ProjectUpdatePatch) {
    const merged = { ...previous, ...patch };
    if (merged.snapshot) {
        if (patch.viewport) merged.snapshot = { ...merged.snapshot, viewport: patch.viewport };
        delete merged.viewport;
    }
    return merged;
}

function enqueueProjectUpdate(id: string, patch: ProjectUpdatePatch) {
    const state = useCanvasStore.getState();
    if (!state.hydrated) return;
    // 工作区 viewer 角色只读：本地编辑不落库，也不会打到服务端 403。
    if (state.projects.find((project) => project.id === id)?.accessRole === "viewer") return;
    const merged = mergeUpdates(pendingUpdates.get(id), patch);
    pendingUpdates.set(id, merged);
    // 已知不可恢复：只保留待写入内容，等用户点重试，不再自动发请求。
    if (blockedProjects.has(id)) return;
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.set(id, setTimeout(() => void flushProjectUpdate(id), CANVAS_SAVE_DEBOUNCE_MS));
}

export async function flushProject(id: string) {
    return flushProjectUpdate(id);
}

async function flushProjectUpdate(id: string) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    if (!useCanvasStore.getState().hydrated) {
        pendingUpdates.delete(id);
        return;
    }
    const saving = savingProjects.get(id);
    if (saving) {
        await saving;
        if (useUserStore.getState().sessionVersion !== sessionVersion) return;
        if (!blockedProjects.has(id) && (savingProjects.has(id) || pendingUpdates.has(id))) await flushProjectUpdate(id);
        return;
    }
    const patch = pendingUpdates.get(id);
    if (!patch || blockedProjects.has(id)) return;
    const project = useCanvasStore.getState().projects.find((item) => item.id === id);
    if (!project) return;
    pendingUpdates.delete(id);
    let failed = false;
    const request = canvasApi
        .updateCanvasProject(id, { ...patch, expectedRevision: project.revision })
        .then((record) => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            if (record.revision < (useCanvasStore.getState().projects.find((item) => item.id === id)?.revision ?? 0)) return;
            if (blockedProjects.has(id) && useCanvasStore.getState().saveError?.conflict) return;
            saveAttempts.delete(id);
            blockedProjects.delete(id);
            useCanvasStore.setState((state) => ({
                saveError: state.saveError?.projectId === id ? null : state.saveError,
                projects: state.projects.map((project) =>
                    project.id === id && record.revision >= project.revision
                        ? {
                              ...project,
                              updatedAt: record.updatedAt,
                              revision: record.revision,
                              nodeCount: patch.snapshot ? patch.snapshot.nodes.length : project.nodeCount,
                              connectionCount: patch.snapshot ? patch.snapshot.connections.length : project.connectionCount,
                          }
                        : project,
                ),
            }));
        })
        .catch((error: unknown) => {
            failed = true;
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            if (deletingProjects.has(id)) return;
            // 失败的改动必须留在队列里，否则这段编辑就永久丢了。
            pendingUpdates.set(id, mergeUpdates(patch, pendingUpdates.get(id) || {}));
            const attempt = (saveAttempts.get(id) ?? 0) + 1;
            saveAttempts.set(id, attempt);
            const permanent = isPermanentFailure(error) || attempt >= MAX_SAVE_ATTEMPTS;
            if (permanent) blockedProjects.add(id);
            else saveTimers.set(id, setTimeout(() => void flushProjectUpdate(id), retryDelay(attempt)));
            useCanvasStore.setState({
                saveError: {
                    projectId: id,
                    message: error instanceof Error ? error.message : i18n.t("canvas.save.failed"),
                    permanent,
                    conflict: error instanceof ApiError && error.status === 409,
                },
            });
        })
        .finally(() => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            savingProjects.delete(id);
        });
    savingProjects.set(id, request);
    await request;
    if (useUserStore.getState().sessionVersion === sessionVersion && !failed && pendingUpdates.has(id)) await flushProjectUpdate(id);
}

function cancelProjectUpdate(id: string) {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    pendingUpdates.delete(id);
    saveAttempts.delete(id);
    blockedProjects.delete(id);
}

canvasApi.onCanvasWorkspaceMove((record) => {
    const current = useCanvasStore.getState().projects.find((project) => project.id === record.id);
    if (!current || record.revision <= current.revision) return;
    const hasUnsavedChanges = pendingUpdates.has(record.id) || savingProjects.has(record.id);
    if (hasUnsavedChanges) {
        blockedProjects.add(record.id);
        const timer = saveTimers.get(record.id);
        if (timer) clearTimeout(timer);
        saveTimers.delete(record.id);
    }
    useCanvasStore.setState((state) => ({
        saveError: hasUnsavedChanges ? { projectId: record.id, message: "工作区变更期间存在未保存的编辑，请先核对远端画布并处理版本冲突", permanent: true, conflict: true } : state.saveError,
        projects: state.projects.map((project) => project.id === record.id && record.revision > project.revision
            ? { ...project, revision: hasUnsavedChanges ? project.revision : record.revision, workspaceId: record.workspaceId || null, workspaceName: record.workspaceName || null, accessRole: record.workspaceId ? project.accessRole : "owner" }
            : project),
    }));
});

export const useCanvasStore = create<CanvasStore>()((set, get) => ({
            hydrated: false,
            hydratedUserId: "",
            projects: [],
            projectListIds: [],
            projectQuery: {},
            projectListLoading: false,
            projectListError: "",
            projectTotal: 0,
            deletedProjects: [],
            saveError: null,
            reloadVersion: 0,
            hydrateProjects: async (userId) => {
                const { sessionVersion, user } = useUserStore.getState();
                if (user?.id !== userId) return;
                if (get().hydrated && get().hydratedUserId === userId) return;
                if (get().hydratedUserId !== userId) set({ projects: [], hydrated: false, hydratedUserId: userId, saveError: null });
                let request = hydratePromises.get(userId);
                if (!request) {
                    request = canvasApi.listCanvasProjects().then((records) => {
                        if (useUserStore.getState().sessionVersion === sessionVersion) set({ projects: records.projects.map(listProject), projectListIds: records.projects.map((project) => project.id), projectTotal: records.total, hydrated: true });
                    }).finally(() => {
                        if (useUserStore.getState().sessionVersion === sessionVersion) hydratePromises.delete(userId);
                    });
                    hydratePromises.set(userId, request);
                }
                await request;
            },
            refreshProjectList: async (query = {}) => {
                const { sessionVersion, user } = useUserStore.getState();
                if (!user) return;
                const requestVersion = ++projectListRequestVersion;
                set({ projectQuery: query, projectListLoading: true, projectListError: "", projectListIds: [], projectTotal: 0 });
                try {
                    const records = await canvasApi.listCanvasProjects(0, query);
                    assertCurrentSession(sessionVersion);
                    if (requestVersion !== projectListRequestVersion) return;
                    set((state) => ({ projects: mergeProjectSummaries(records.projects, state.projects), projectListIds: records.projects.map((project) => project.id), projectTotal: records.total }));
                } catch (error) {
                    if (useUserStore.getState().sessionVersion === sessionVersion && requestVersion === projectListRequestVersion) set({ projectListError: error instanceof Error ? error.message : "画布加载失败" });
                    throw error;
                } finally {
                    if (useUserStore.getState().sessionVersion === sessionVersion && requestVersion === projectListRequestVersion) set({ projectListLoading: false });
                }
            },
            // 画布列表默认只取前 200 个，超出部分由页面上的「加载更多」按需追加。
            loadMoreProjects: async () => {
                const { sessionVersion, user } = useUserStore.getState();
                if (!user || get().projectListLoading) return;
                const requestVersion = projectListRequestVersion;
                const { projectListIds, projectQuery } = get();
                set({ projectListLoading: true });
                try {
                    const records = await canvasApi.listCanvasProjects(projectListIds.length, projectQuery);
                    assertCurrentSession(sessionVersion);
                    if (requestVersion !== projectListRequestVersion) return;
                    set((state) => ({ projects: mergeProjectSummaries(records.projects, state.projects), projectListIds: [...new Set([...state.projectListIds, ...records.projects.map((project) => project.id)])], projectTotal: records.total }));
                } finally {
                    if (useUserStore.getState().sessionVersion === sessionVersion && requestVersion === projectListRequestVersion) set({ projectListLoading: false });
                }
            },
            createProject: async (title = i18n.t("canvas.project.untitled"), workspaceId) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                const project = detailProject(await canvasApi.createCanvasProject({ title, snapshot: emptySnapshot(), workspaceId: workspaceId || undefined }));
                assertCurrentSession(sessionVersion);
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            importProject: async (source) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                const snapshot: CanvasSnapshot = {
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                const project = detailProject(await canvasApi.createCanvasProject({ title: source.title || i18n.t("canvas.project.imported"), snapshot }));
                assertCurrentSession(sessionVersion);
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            // 服务端已创建的项目（如从模板生成）直接纳入本地列表，避免再拉一次详情。
            adoptProject: (record) => mergeProject(detailProject(record)).id,
            loadProject: async (id) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                const cached = get().projects.find((item) => item.id === id);
                if (cached?.snapshotLoaded && (pendingUpdates.has(id) || savingProjects.has(id) || blockedProjects.has(id))) return cached;
                let request = loadPromises.get(id);
                if (!request) {
                    request = canvasApi
                        .getCanvasProject(id)
                        .then((record) => useUserStore.getState().sessionVersion === sessionVersion ? mergeProject(detailProject(record)) : null)
                        .catch((error: unknown) => {
                            if (useUserStore.getState().sessionVersion !== sessionVersion) return null;
                            if (error instanceof ApiError && error.status === 404) {
                                set((state) => ({ projects: state.projects.filter((item) => item.id !== id), projectListIds: state.projectListIds.filter((item) => item !== id), projectTotal: Math.max(0, state.projectTotal - Number(state.projectListIds.includes(id))) }));
                                return null;
                            }
                            throw error;
                        })
                        .finally(() => {
                            if (useUserStore.getState().sessionVersion === sessionVersion) loadPromises.delete(id);
                        });
                    loadPromises.set(id, request);
                }
                return request;
            },
            loadProjects: async (ids) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                const loaded = await Promise.all(ids.map((id) => get().loadProject(id)));
                assertCurrentSession(sessionVersion);
                return loaded.filter((project): project is CanvasProject => Boolean(project));
            },
            renameProject: async (id, title) => {
                const project = get().projects.find((item) => item.id === id);
                if (!project) return;
                const nextTitle = title.trim() || project.title;
                set((state) => ({
                    projects: state.projects.map((item) => (item.id === id ? { ...item, title: nextTitle, updatedAt: new Date().toISOString() } : item)),
                }));
                if (get().hydrated) enqueueProjectUpdate(id, { title: nextTitle });
            },
            deleteProjects: async (ids) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                ids.forEach((id) => deletingProjects.add(id));
                ids.forEach(cancelProjectUpdate);
                try {
                    await Promise.all(ids.map((id) => savingProjects.get(id)).filter((request): request is Promise<void> => Boolean(request)));
                    assertCurrentSession(sessionVersion);
                    ids.forEach(cancelProjectUpdate);
                    await Promise.all(ids.map(canvasApi.deleteCanvasProject));
                    assertCurrentSession(sessionVersion);
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    set((state) => ({
                        projects: state.projects.filter((project) => !removing.has(project.id)),
                        projectListIds: state.projectListIds.filter((id) => !removing.has(id)),
                        projectTotal: Math.max(0, state.projectTotal - state.projectListIds.filter((id) => removing.has(id)).length),
                        deletedProjects: [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))],
                        saveError: state.saveError && ids.includes(state.saveError.projectId) ? null : state.saveError,
                    }));
                    void get().refreshProjectList(get().projectQuery).catch(() => undefined);
                } finally {
                    if (useUserStore.getState().sessionVersion === sessionVersion) ids.forEach((id) => deletingProjects.delete(id));
                }
            },
            replaceProjects: (projects, deletedProjects = []) => set({ projects, deletedProjects }),
            updateProject: (id, patch) => {
                // 快照没加载完就写回去会把服务端的真实内容覆盖成空画布。
                if (!get().projects.find((project) => project.id === id)?.snapshotLoaded) return;
                let updated: CanvasProject | undefined;
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== id) return project;
                        updated = { ...project, ...patch, updatedAt: new Date().toISOString() };
                        return updated;
                    }),
                }));
                if (!updated || !get().hydrated) return;
                // 平移和缩放只改视口，单独走小写入，避免整份快照重传重写。
                enqueueProjectUpdate(id, Object.keys(patch).every((key) => key === "viewport") ? { viewport: updated.viewport } : { snapshot: projectSnapshot(updated) });
            },
            applyRestoredProject: (record) => {
                const current = get().projects.find((project) => project.id === record.id);
                if (!current) return;
                cancelProjectUpdate(record.id);
                mergeProject({ ...detailProject(record), accessRole: current.accessRole, workspaceId: current.workspaceId, workspaceName: current.workspaceName, canDelete: current.canDelete }, false);
                set((state) => ({ saveError: state.saveError?.projectId === record.id ? null : state.saveError }));
            },
            flushProject: async (id) => flushProject(id),
            retrySave: async (id) => {
                // 通用“重试”不能擅自把过期的完整快照覆盖到协作者的新版本上；待写入编辑保留到明确解决冲突为止。
                if (get().saveError?.projectId === id && get().saveError?.conflict) return;
                blockedProjects.delete(id);
                saveAttempts.delete(id);
                set((state) => ({ saveError: state.saveError?.projectId === id ? null : state.saveError }));
                await flushProjectUpdate(id);
            },
            hasPendingChanges: (id) => pendingUpdates.has(id) || savingProjects.has(id),
            registerSnapshotCapture: (id, capture) => {
                snapshotCaptures.set(id, capture);
                return () => { if (snapshotCaptures.get(id) === capture) snapshotCaptures.delete(id); };
            },
            resolveConflict: async (id, action) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                await savingProjects.get(id);
                assertCurrentSession(sessionVersion);
                snapshotCaptures.get(id)?.();
                const local = get().projects.find((project) => project.id === id);
                if (!local) throw new Error("画布不存在");
                if (action === "copy") {
                    const copyId = await get().importProject({ ...local, title: `${local.title}（本地副本）` });
                    assertCurrentSession(sessionVersion);
                    snapshotCaptures.get(id)?.();
                    if (get().projects.find((project) => project.id === id) !== local) throw new Error("副本已创建，但本地又有新编辑；请核对后再处理冲突");
                    cancelProjectUpdate(id);
                    set((state) => ({ projects: state.projects.map((project) => project.id === id ? { ...project, snapshotLoaded: false } : project), saveError: state.saveError?.projectId === id ? null : state.saveError }));
                    return copyId;
                }
                const remote = await canvasApi.getCanvasProject(id);
                assertCurrentSession(sessionVersion);
                snapshotCaptures.get(id)?.();
                if (get().projects.find((project) => project.id === id) !== local) throw new Error("本地编辑已变化，请重新核对后加载远端版本");
                cancelProjectUpdate(id);
                const restored = detailProject(remote);
                set((state) => ({ projects: state.projects.map((project) => project.id === id ? restored : project), saveError: state.saveError?.projectId === id ? null : state.saveError, reloadVersion: state.reloadVersion + 1 }));
                return id;
            },
}));

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion === previous.sessionVersion) return;
    projectListRequestVersion += 1;
    saveTimers.forEach(clearTimeout);
    saveTimers.clear();
    pendingUpdates.clear();
    savingProjects.clear();
    deletingProjects.clear();
    hydratePromises.clear();
    loadPromises.clear();
    snapshotCaptures.clear();
    saveAttempts.clear();
    blockedProjects.clear();
    useCanvasStore.setState({ hydrated: false, hydratedUserId: "", projects: [], projectListIds: [], projectQuery: {}, projectListLoading: false, projectListError: "", projectTotal: 0, deletedProjects: [], saveError: null });
});
