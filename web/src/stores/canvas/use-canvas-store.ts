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
    /** 列表接口只下发规模统计；快照要等 loadProject 拉取详情后才可用。 */
    nodeCount: number;
    connectionCount: number;
    snapshotLoaded: boolean;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasSaveError = { projectId: string; message: string; permanent: boolean };

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    hydratedUserId: string;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    saveError: CanvasSaveError | null;
    hydrateProjects: (userId: string) => Promise<void>;
    createProject: (title?: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>) => Promise<string>;
    loadProject: (id: string) => Promise<CanvasProject | null>;
    loadProjects: (ids: string[]) => Promise<CanvasProject[]>;
    renameProject: (id: string, title: string) => Promise<void>;
    deleteProjects: (ids: string[]) => Promise<void>;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
    applyRestoredProject: (record: canvasApi.CanvasProjectDetail) => void;
    flushProject: (id: string) => Promise<void>;
    retrySave: (id: string) => Promise<void>;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
type CanvasSnapshot = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">;
const emptySnapshot = (): CanvasSnapshot => ({ nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: initialViewport });
const pendingUpdates = new Map<string, { title?: string; snapshot?: CanvasSnapshot }>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const savingProjects = new Map<string, Promise<void>>();
const deletingProjects = new Set<string>();
const hydratePromises = new Map<string, Promise<void>>();
const loadPromises = new Map<string, Promise<CanvasProject | null>>();
const saveAttempts = new Map<string, number>();
/** 命中不可恢复错误（如 413、400）后停止自动重试，改由用户手动重试，避免无限循环打爆接口。 */
const blockedProjects = new Set<string>();
const CANVAS_SAVE_DEBOUNCE_MS = 1000;
const MAX_SAVE_ATTEMPTS = 5;

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

function listProject(record: canvasApi.CanvasProjectSummary): CanvasProject {
    return {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        nodeCount: record.nodeCount,
        connectionCount: record.connectionCount,
        snapshotLoaded: false,
        ...emptySnapshot(),
    };
}

function detailProject(record: canvasApi.CanvasProjectDetail): CanvasProject {
    const snapshot = record.snapshot && typeof record.snapshot === "object" ? (record.snapshot as Partial<CanvasSnapshot>) : {};
    const merged = { ...emptySnapshot(), ...snapshot };
    return {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        nodeCount: merged.nodes.length,
        connectionCount: merged.connections.length,
        snapshotLoaded: true,
        ...merged,
    };
}

function mergeProject(project: CanvasProject) {
    // 详情请求可能比一次未落盘的重命名慢，落库中的新标题优先，避免列表标题回跳。
    const pendingTitle = pendingUpdates.get(project.id)?.title;
    const next = pendingTitle ? { ...project, title: pendingTitle } : project;
    useCanvasStore.setState((state) => ({
        projects: state.projects.some((item) => item.id === next.id)
            ? state.projects.map((item) => (item.id === next.id ? next : item))
            : [next, ...state.projects],
    }));
    return next;
}

function enqueueProjectUpdate(id: string, patch: { title?: string; snapshot?: CanvasSnapshot }) {
    if (!useCanvasStore.getState().hydrated) return;
    pendingUpdates.set(id, { ...pendingUpdates.get(id), ...patch });
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
        if (savingProjects.has(id) || (!blockedProjects.has(id) && pendingUpdates.has(id))) await flushProjectUpdate(id);
        return;
    }
    const patch = pendingUpdates.get(id);
    if (!patch) return;
    pendingUpdates.delete(id);
    let failed = false;
    const request = canvasApi
        .updateCanvasProject(id, patch)
        .then((record) => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            saveAttempts.delete(id);
            blockedProjects.delete(id);
            useCanvasStore.setState((state) => ({
                saveError: state.saveError?.projectId === id ? null : state.saveError,
                projects: state.projects.map((project) =>
                    project.id === id
                        ? {
                              ...project,
                              updatedAt: record.updatedAt,
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
            pendingUpdates.set(id, { ...patch, ...pendingUpdates.get(id) });
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

export const useCanvasStore = create<CanvasStore>()((set, get) => ({
            hydrated: false,
            hydratedUserId: "",
            projects: [],
            deletedProjects: [],
            saveError: null,
            hydrateProjects: async (userId) => {
                const { sessionVersion, user } = useUserStore.getState();
                if (user?.id !== userId) return;
                if (get().hydrated && get().hydratedUserId === userId) return;
                if (get().hydratedUserId !== userId) set({ projects: [], hydrated: false, hydratedUserId: userId, saveError: null });
                let request = hydratePromises.get(userId);
                if (!request) {
                    request = canvasApi.listCanvasProjects().then((records) => {
                        if (useUserStore.getState().sessionVersion === sessionVersion) set({ projects: records.map(listProject), hydrated: true });
                    }).finally(() => {
                        if (useUserStore.getState().sessionVersion === sessionVersion) hydratePromises.delete(userId);
                    });
                    hydratePromises.set(userId, request);
                }
                await request;
            },
            createProject: async (title = i18n.t("canvas.project.untitled")) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                const project = detailProject(await canvasApi.createCanvasProject({ title, snapshot: emptySnapshot() }));
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
            loadProject: async (id) => {
                const sessionVersion = useUserStore.getState().sessionVersion;
                const cached = get().projects.find((item) => item.id === id);
                if (cached?.snapshotLoaded) return cached;
                let request = loadPromises.get(id);
                if (!request) {
                    request = canvasApi
                        .getCanvasProject(id)
                        .then((record) => useUserStore.getState().sessionVersion === sessionVersion ? mergeProject(detailProject(record)) : null)
                        .catch((error: unknown) => {
                            if (useUserStore.getState().sessionVersion !== sessionVersion) return null;
                            if (error instanceof ApiError && error.status === 404) {
                                set((state) => ({ projects: state.projects.filter((item) => item.id !== id) }));
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
                        deletedProjects: [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))],
                        saveError: state.saveError && ids.includes(state.saveError.projectId) ? null : state.saveError,
                    }));
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
                if (updated && get().hydrated) enqueueProjectUpdate(id, { snapshot: projectSnapshot(updated) });
            },
            applyRestoredProject: (record) => {
                if (!get().projects.some((project) => project.id === record.id)) return;
                cancelProjectUpdate(record.id);
                mergeProject(detailProject(record));
                set((state) => ({ saveError: state.saveError?.projectId === record.id ? null : state.saveError }));
            },
            flushProject: async (id) => flushProject(id),
            retrySave: async (id) => {
                blockedProjects.delete(id);
                saveAttempts.delete(id);
                set((state) => ({ saveError: state.saveError?.projectId === id ? null : state.saveError }));
                await flushProjectUpdate(id);
            },
}));

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion === previous.sessionVersion) return;
    saveTimers.forEach(clearTimeout);
    saveTimers.clear();
    pendingUpdates.clear();
    savingProjects.clear();
    deletingProjects.clear();
    hydratePromises.clear();
    loadPromises.clear();
    saveAttempts.clear();
    blockedProjects.clear();
    useCanvasStore.setState({ hydrated: false, hydratedUserId: "", projects: [], deletedProjects: [], saveError: null });
});
