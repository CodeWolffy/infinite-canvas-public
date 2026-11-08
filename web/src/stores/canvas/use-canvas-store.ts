import { create } from "zustand";
import stringify from "fast-json-stable-stringify";
import i18n from "@/i18n";
import * as canvasApi from "@/services/api/canvas-projects";
import { ApiError } from "@/services/api/request";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { mergeCanvasSnapshots } from "@/lib/canvas/canvas-collaboration-merge";
import { createCanvasRecovery, readCanvasRecoveries, removeCanvasRecovery, writeCanvasRecovery, type CanvasRecovery } from "@/lib/canvas/canvas-recovery";

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
    canManageSharing?: boolean;
    collaborationVersion?: number;
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
export type CanvasSaveState = { phase: "pending" | "saving" | "saved"; error: CanvasSaveError | null; sessionVersion: number };

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
    saveStates: Record<string, CanvasSaveState>;
    recoveries: Record<string, CanvasRecovery[]>;
    recoveryErrors: Record<string, string>;
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
    retainRecovery: (id: string, snapshot: CanvasSnapshot) => void;
    resolveRecovery: (id: string, key: string, action: "restore" | "copy" | "discard") => Promise<string>;
    resolveConflict: (id: string, action: "reload" | "copy") => Promise<string>;
    acceptRemoteProject: (record: canvasApi.CanvasProjectDetail) => void;
    suspendProjectAccess: (id: string) => void;
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
const serverProjects = new Map<string, CanvasProject>();
const deferredRemoteProjects = new Map<string, canvasApi.CanvasProjectDetail>();
const saveAttempts = new Map<string, number>();
const activeRecoveries = new Map<string, CanvasRecovery>();
const recoveryWrites = new Map<string, Promise<boolean>>();
const recoveryViewports = new Map<string, ViewportTransform>();
/** 命中不可恢复错误（如 413、400）后停止自动重试，改由用户手动重试，避免无限循环打爆接口。 */
const blockedProjects = new Set<string>();
const CANVAS_SAVE_DEBOUNCE_MS = 1000;
const MAX_SAVE_ATTEMPTS = 5;
let projectListRequestVersion = 0;

function publishSaveState(id: string, error?: CanvasSaveError | null) {
    useCanvasStore.setState((state) => {
        const previous = state.saveStates[id];
        const next: CanvasSaveState = {
            phase: savingProjects.has(id) ? "saving" : pendingUpdates.has(id) || blockedProjects.has(id) || deletingProjects.has(id) ? "pending" : "saved",
            error: error === undefined ? previous?.error || null : error,
            sessionVersion: useUserStore.getState().sessionVersion,
        };
        if (previous?.phase === next.phase && previous.error === next.error && previous.sessionVersion === next.sessionVersion) return state;
        return { saveStates: { ...state.saveStates, [id]: next }, ...(error !== undefined ? { saveError: error || (state.saveError?.projectId === id ? null : state.saveError) } : {}) };
    });
}

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

function recoveryError(id: string, message: string) {
    useCanvasStore.setState((state) => ({ recoveryErrors: { ...state.recoveryErrors, [id]: message } }));
}

function persistProjectRecovery(id: string) {
    const { user, sessionVersion } = useUserStore.getState();
    const project = useCanvasStore.getState().projects.find((item) => item.id === id);
    if (!user || !project) return;
    const previous = activeRecoveries.get(id);
    const viewport = recoveryViewports.get(id);
    const nextSnapshot = project.snapshotLoaded ? { ...projectSnapshot(project), ...(viewport ? { viewport } : {}) } : undefined;
    const baseRevision = serverProjects.get(id)?.revision ?? project.revision;
    if (previous?.baseRevision === baseRevision && previous.title === project.title && previous.snapshot && nextSnapshot && Object.entries(nextSnapshot).every(([key, value]) => key === "viewport" ? stringify(value) === stringify(previous.snapshot!.viewport) : previous.snapshot![key as keyof CanvasSnapshot] === value)) return;
    const record = createCanvasRecovery({ userId: user.id, projectId: id, baseRevision, title: project.title, snapshot: nextSnapshot }, previous);
    activeRecoveries.set(id, record);
    const isCurrent = () => useUserStore.getState().sessionVersion === sessionVersion;
    const writing = (recoveryWrites.get(id) || Promise.resolve()).then(async () => {
        // 仅合并尚未开始的写入；已经落盘的旧版由下一次成功写入或对应保存完成后清理。
        if (!isCurrent() || activeRecoveries.get(id) !== record) return false;
        await writeCanvasRecovery(record, previous, isCurrent);
        if (isCurrent() && activeRecoveries.get(id) === record) recoveryError(id, "");
        return isCurrent();
    }).catch(() => {
        if (isCurrent()) recoveryError(id, "浏览器恢复副本写入失败，请先完成服务端保存再刷新或关闭页面");
        return false;
    });
    recoveryWrites.set(id, writing);
}

function clearProjectRecovery(id: string, record = activeRecoveries.get(id)) {
    if (!record) return;
    const sessionVersion = useUserStore.getState().sessionVersion;
    if (activeRecoveries.get(id) === record) activeRecoveries.delete(id);
    recoveryWrites.set(id, (recoveryWrites.get(id) || Promise.resolve()).then(() => removeCanvasRecovery(record, () => useUserStore.getState().sessionVersion === sessionVersion)).then(() => {
        if (useUserStore.getState().sessionVersion === sessionVersion && !activeRecoveries.has(id)) recoveryError(id, "");
        return true;
    }).catch(() => {
        if (useUserStore.getState().sessionVersion === sessionVersion) recoveryError(id, "恢复副本清理失败，下次打开时请核对服务端内容");
        return false;
    }));
}

function accessFields(record: canvasApi.CanvasProjectSummary) {
    return {
        accessRole: record.accessRole ?? "owner",
        workspaceId: record.workspaceId || null,
        workspaceName: record.workspaceName || null,
        canDelete: record.canDelete !== false,
        canManageSharing: record.canManageSharing === true,
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
    if ((!preserveLocal || !pendingUpdates.has(project.id) && !savingProjects.has(project.id) && !blockedProjects.has(project.id)) && project.revision >= (serverProjects.get(project.id)?.revision ?? -1)) serverProjects.set(project.id, project);
    useCanvasStore.setState((state) => ({
        projects: state.projects.some((item) => item.id === project.id)
            ? state.projects.map((current) => {
                if (current.id !== project.id) return current;
                const pending = pendingUpdates.get(project.id);
                // 迟到的详情不能覆盖本地编辑，也不能把远端新版本号套在未保存的旧快照上。
                if (preserveLocal && (pending || savingProjects.has(project.id) || blockedProjects.has(project.id) || current.revision > project.revision)) {
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
    const role = state.projects.find((project) => project.id === id)?.accessRole;
    if (role === "" || role === "viewer" && (patch.title !== undefined || patch.snapshot !== undefined)) return;
    const merged = mergeUpdates(pendingUpdates.get(id), patch);
    pendingUpdates.set(id, merged);
    persistProjectRecovery(id);
    publishSaveState(id);
    // 已知不可恢复：只保留待写入内容，等用户点重试，不再自动发请求。
    if (blockedProjects.has(id)) return;
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.set(id, setTimeout(() => void flushProjectUpdate(id), CANVAS_SAVE_DEBOUNCE_MS));
}

export async function flushProject(id: string) {
    await flushProjectUpdate(id);
    await recoveryWrites.get(id);
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
    if (!pendingUpdates.has(id) || blockedProjects.has(id)) return;
    snapshotCaptures.get(id)?.();
    const patch = pendingUpdates.get(id)!;
    const project = useCanvasStore.getState().projects.find((item) => item.id === id);
    if (!project) return;
    const base = serverProjects.get(id);
    const recovery = activeRecoveries.get(id);
    pendingUpdates.delete(id);
    let failed = false;
    const request = canvasApi
        .updateCanvasProject(id, { ...patch, expectedRevision: base?.revision ?? project.revision, ...(patch.snapshot && base ? { baseSnapshot: projectSnapshot(base) } : {}), ...(patch.title !== undefined && base ? { baseTitle: base.title } : {}) })
        .then((record) => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            if (record.revision < (useCanvasStore.getState().projects.find((item) => item.id === id)?.revision ?? 0)) return;
            if (blockedProjects.has(id) && useCanvasStore.getState().saveStates[id]?.error?.permanent) return;
            snapshotCaptures.get(id)?.();
            if (record.snapshot) {
                const authoritative = detailProject({ ...record, snapshot: record.snapshot });
                const local = useCanvasStore.getState().projects.find((item) => item.id === id)!;
                serverProjects.set(id, authoritative);
                const rebased = mergeCanvasSnapshots(patch.snapshot || projectSnapshot(project), projectSnapshot(local), projectSnapshot(authoritative));
                const changed = stringify([rebased.nodes, rebased.connections, rebased.backgroundMode, rebased.showImageInfo]) !== stringify([local.nodes, local.connections, local.backgroundMode, local.showImageInfo]);
                const next = { ...local, ...(changed ? rebased : {}), backgroundMode: rebased.backgroundMode as CanvasBackgroundMode, title: pendingUpdates.get(id)?.title ?? authoritative.title, revision: record.revision, updatedAt: record.updatedAt, collaborationVersion: (local.collaborationVersion || 0) + Number(changed) };
                useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === id ? next : item) }));
                const pending = pendingUpdates.get(id);
                if (pending?.snapshot) pendingUpdates.set(id, { ...pending, snapshot: projectSnapshot(next) });
            } else if (base) {
                serverProjects.set(id, { ...base, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.viewport ? { viewport: patch.viewport } : {}), ...(patch.snapshot || {}), revision: record.revision, updatedAt: record.updatedAt });
            }
            saveAttempts.delete(id);
            blockedProjects.delete(id);
            publishSaveState(id, null);
            useCanvasStore.setState((state) => ({
                saveError: state.saveError?.projectId === id ? null : state.saveError,
                projects: state.projects.map((project) =>
                    project.id === id && record.revision >= project.revision
                        ? {
                              ...project,
                              updatedAt: record.updatedAt,
                              revision: record.revision,
                              nodeCount: project.nodes.length,
                              connectionCount: project.connections.length,
                          }
                        : project,
                ),
            }));
            const localViewport = recoveryViewports.get(id);
            const savedViewport = useCanvasStore.getState().projects.find((item) => item.id === id)?.viewport;
            if (pendingUpdates.has(id) || localViewport && stringify(localViewport) !== stringify(savedViewport)) persistProjectRecovery(id);
            else clearProjectRecovery(id, recovery);
        })
        .catch((error: unknown) => {
            failed = true;
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            if (deletingProjects.has(id)) return;
            // 失败的改动必须留在队列里，否则这段编辑就永久丢了。
            pendingUpdates.set(id, mergeUpdates(patch, pendingUpdates.get(id) || {}));
            const attempt = (saveAttempts.get(id) ?? 0) + 1;
            saveAttempts.set(id, attempt);
            const mergeConflict = !(error instanceof ApiError) && Boolean(serverProjects.get(id)?.revision !== base?.revision);
            const permanent = mergeConflict || isPermanentFailure(error) || attempt >= MAX_SAVE_ATTEMPTS;
            if (permanent) blockedProjects.add(id);
            else saveTimers.set(id, setTimeout(() => void flushProjectUpdate(id), retryDelay(attempt)));
            publishSaveState(id, {
                projectId: id,
                message: error instanceof Error ? error.message : i18n.t("canvas.save.failed"),
                permanent,
                conflict: mergeConflict || error instanceof ApiError && error.status === 409,
            });
        })
        .finally(() => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            savingProjects.delete(id);
            const remote = deferredRemoteProjects.get(id);
            deferredRemoteProjects.delete(id);
            if (remote) useCanvasStore.getState().acceptRemoteProject(remote);
            publishSaveState(id);
        });
    savingProjects.set(id, request);
    publishSaveState(id);
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
    publishSaveState(id, null);
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
        publishSaveState(record.id, { projectId: record.id, message: "工作区变更期间存在未保存的编辑，请先核对远端画布并处理版本冲突", permanent: true, conflict: true });
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
            saveStates: {},
            recoveries: {},
            recoveryErrors: {},
            reloadVersion: 0,
            hydrateProjects: async (userId) => {
                const { sessionVersion, user } = useUserStore.getState();
                if (user?.id !== userId) return;
                if (get().hydrated && get().hydratedUserId === userId) return;
                if (get().hydratedUserId !== userId) set({ projects: [], hydrated: false, hydratedUserId: userId, saveError: null, saveStates: {} });
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
                serverProjects.set(project.id, project);
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
                serverProjects.set(project.id, project);
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            // 服务端已创建的项目（如从模板生成）直接纳入本地列表，避免再拉一次详情。
            adoptProject: (record) => mergeProject(detailProject(record)).id,
            loadProject: async (id) => {
                const { sessionVersion, user } = useUserStore.getState();
                const cached = get().projects.find((item) => item.id === id);
                if (cached?.snapshotLoaded && (pendingUpdates.has(id) || savingProjects.has(id) || blockedProjects.has(id))) return cached;
                let request = loadPromises.get(id);
                if (!request) {
                    request = Promise.all([
                        canvasApi.getCanvasProject(id),
                        user ? readCanvasRecoveries(user.id, id).catch(() => {
                            if (useUserStore.getState().sessionVersion === sessionVersion) recoveryError(id, "无法读取浏览器恢复副本，请稍后重新打开画布");
                            return [];
                        }) : Promise.resolve([]),
                    ])
                        .then(([record, recoveries]) => {
                            if (useUserStore.getState().sessionVersion !== sessionVersion) return null;
                            set((state) => ({ recoveries: { ...state.recoveries, [id]: recoveries.filter((item) => item.key !== activeRecoveries.get(id)?.key) } }));
                            return mergeProject(detailProject(record));
                        })
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
                    ids.forEach((id) => clearProjectRecovery(id));
                    ids.forEach((id) => { serverProjects.delete(id); deferredRemoteProjects.delete(id); });
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    set((state) => ({
                        projects: state.projects.filter((project) => !removing.has(project.id)),
                        projectListIds: state.projectListIds.filter((id) => !removing.has(id)),
                        projectTotal: Math.max(0, state.projectTotal - state.projectListIds.filter((id) => removing.has(id)).length),
                        deletedProjects: [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))],
                        saveError: state.saveError && ids.includes(state.saveError.projectId) ? null : state.saveError,
                        saveStates: Object.fromEntries(Object.entries(state.saveStates).filter(([id]) => !removing.has(id))),
                    }));
                    void get().refreshProjectList(get().projectQuery).catch(() => undefined);
                } finally {
                    if (useUserStore.getState().sessionVersion === sessionVersion) ids.forEach((id) => {
                        deletingProjects.delete(id);
                        if (get().projects.some((project) => project.id === id)) publishSaveState(id);
                    });
                }
            },
            replaceProjects: (projects, deletedProjects = []) => set({ projects, deletedProjects }),
            updateProject: (id, patch) => {
                // 快照没加载完就写回去会把服务端的真实内容覆盖成空画布。
                const current = get().projects.find((project) => project.id === id);
                if (!current?.snapshotLoaded || current.accessRole === "") return;
                if (current.accessRole === "viewer") patch = patch.viewport ? { viewport: patch.viewport } : {};
                if (!Object.keys(patch).length || Object.entries(patch).every(([key, value]) => key === "viewport" ? JSON.stringify(current.viewport) === JSON.stringify(value) : current[key as keyof CanvasProject] === value)) return;
                if (patch.viewport) recoveryViewports.set(id, patch.viewport);
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
                clearProjectRecovery(record.id);
                recoveryViewports.delete(record.id);
                mergeProject({ ...detailProject(record), accessRole: current.accessRole, workspaceId: current.workspaceId, workspaceName: current.workspaceName, canDelete: current.canDelete }, false);
                set((state) => ({ saveError: state.saveError?.projectId === record.id ? null : state.saveError }));
            },
            flushProject: async (id) => flushProject(id),
            retrySave: async (id) => {
                // 通用“重试”不能擅自把过期的完整快照覆盖到协作者的新版本上；待写入编辑保留到明确解决冲突为止。
                if (get().saveStates[id]?.error?.conflict) return;
                blockedProjects.delete(id);
                saveAttempts.delete(id);
                publishSaveState(id, null);
                set((state) => ({ saveError: state.saveError?.projectId === id ? null : state.saveError }));
                await flushProjectUpdate(id);
            },
            hasPendingChanges: (id) => pendingUpdates.has(id) || savingProjects.has(id),
            registerSnapshotCapture: (id, capture) => {
                snapshotCaptures.set(id, capture);
                return () => { if (snapshotCaptures.get(id) === capture) snapshotCaptures.delete(id); };
            },
            retainRecovery: (id, snapshot) => {
                const project = get().projects.find((item) => item.id === id);
                if (!project?.snapshotLoaded || !get().hydrated || project.accessRole === "") return;
                if (stringify(project.viewport) === stringify(snapshot.viewport)) {
                    recoveryViewports.delete(id);
                    if (!get().hasPendingChanges(id) && !blockedProjects.has(id)) { clearProjectRecovery(id); return; }
                } else recoveryViewports.set(id, snapshot.viewport);
                persistProjectRecovery(id);
            },
            resolveRecovery: async (id, key, action) => {
                const { sessionVersion, user } = useUserStore.getState();
                const recovery = get().recoveries[id]?.find((item) => item.key === key && item.userId === user?.id);
                if (!recovery) throw new Error("恢复副本已变化，请重新打开画布");
                const forget = async () => {
                    await removeCanvasRecovery(recovery, () => useUserStore.getState().sessionVersion === sessionVersion);
                    assertCurrentSession(sessionVersion);
                    set((state) => ({ recoveries: { ...state.recoveries, [id]: state.recoveries[id].filter((item) => item.key !== key) } }));
                };
                if (action === "discard") { await forget(); return id; }
                if (action === "copy") {
                    const snapshot = recovery.snapshot || projectSnapshot(detailProject(await canvasApi.getCanvasProject(id)));
                    assertCurrentSession(sessionVersion);
                    const copyId = await get().importProject({ ...snapshot, title: `${recovery.title}（恢复副本）` });
                    assertCurrentSession(sessionVersion);
                    await forget();
                    return copyId;
                }
                snapshotCaptures.get(id)?.();
                if (get().hasPendingChanges(id)) throw new Error("当前画布已有新编辑，请先保存，或将恢复副本另存为新画布");
                const current = get().projects.find((project) => project.id === id);
                const remote = detailProject(await canvasApi.getCanvasProject(id));
                assertCurrentSession(sessionVersion);
                snapshotCaptures.get(id)?.();
                if (get().projects.find((project) => project.id === id) !== current || get().hasPendingChanges(id)) throw new Error("当前画布已有新编辑，请先保存，或将恢复副本另存为新画布");
                if (remote.revision !== recovery.baseRevision) throw new Error("远端画布版本已变化，请另存恢复副本，避免覆盖远端内容");
                if (remote.accessRole === "viewer" || remote.accessRole === "") throw new Error("当前画布不可编辑，请另存恢复副本");
                recoveryViewports.delete(id);
                serverProjects.set(id, remote);
                const restored = { ...remote, ...recovery.snapshot, title: recovery.title };
                set((state) => ({ projects: state.projects.map((project) => project.id === id ? restored : project), reloadVersion: state.reloadVersion + 1 }));
                enqueueProjectUpdate(id, { title: restored.title, snapshot: projectSnapshot(restored) });
                const backedUp = await recoveryWrites.get(id);
                assertCurrentSession(sessionVersion);
                if (get().recoveryErrors[id]) throw new Error("恢复内容已载入，但浏览器备份失败；原恢复副本仍保留，请先完成保存");
                if (!backedUp) throw new Error("恢复内容已载入，后续编辑仍待保存；原恢复副本暂时保留");
                await forget();
                return id;
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
                    clearProjectRecovery(id);
                    recoveryViewports.delete(id);
                    set((state) => ({ projects: state.projects.map((project) => project.id === id ? { ...project, snapshotLoaded: false } : project), saveError: state.saveError?.projectId === id ? null : state.saveError }));
                    return copyId;
                }
                const remote = await canvasApi.getCanvasProject(id);
                assertCurrentSession(sessionVersion);
                snapshotCaptures.get(id)?.();
                if (get().projects.find((project) => project.id === id) !== local) throw new Error("本地编辑已变化，请重新核对后加载远端版本");
                cancelProjectUpdate(id);
                clearProjectRecovery(id);
                recoveryViewports.delete(id);
                const restored = detailProject(remote);
                serverProjects.set(id, restored);
                set((state) => ({ projects: state.projects.map((project) => project.id === id ? restored : project), saveError: state.saveError?.projectId === id ? null : state.saveError, reloadVersion: state.reloadVersion + 1 }));
                return id;
            },
            acceptRemoteProject: (record) => {
                const id = record.id;
                if (savingProjects.has(id)) { deferredRemoteProjects.set(id, record); return; }
                const base = serverProjects.get(id);
                if (!base || record.revision < base.revision) return;
                snapshotCaptures.get(id)?.();
                const local = get().projects.find((item) => item.id === id);
                if (!local?.snapshotLoaded) return;
                const access = accessFields(record);
                if (access.accessRole === "viewer" && local.accessRole !== "viewer" && pendingUpdates.has(id)) {
                    const timer = saveTimers.get(id);
                    if (timer) clearTimeout(timer);
                    saveTimers.delete(id);
                    blockedProjects.add(id);
                    publishSaveState(id, { projectId: id, message: "权限已改为只读，本地未保存编辑已保留，可通过保存冲突入口另存副本", permanent: true, conflict: true });
                }
                set((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, ...access } : item) }));
                if (record.revision === base.revision) {
                    return;
                }
                if (blockedProjects.has(id)) return;
                try {
                    const remote = detailProject(record);
                    const shared = mergeCanvasSnapshots(projectSnapshot(base), projectSnapshot(local), projectSnapshot(remote));
                    if (local.title !== base.title && remote.title !== base.title && remote.title !== local.title) throw new Error("画布标题已被其他协作者修改");
                    const changed = stringify([shared.nodes, shared.connections, shared.backgroundMode, shared.showImageInfo]) !== stringify([local.nodes, local.connections, local.backgroundMode, local.showImageInfo]);
                    const next = { ...local, ...(changed ? shared : {}), ...access, backgroundMode: shared.backgroundMode as CanvasBackgroundMode, title: local.title === base.title ? remote.title : local.title, revision: remote.revision, updatedAt: remote.updatedAt, collaborationVersion: (local.collaborationVersion || 0) + Number(changed) };
                    serverProjects.set(id, { ...remote, viewport: local.viewport, chatSessions: local.chatSessions, activeChatId: local.activeChatId });
                    const pending = pendingUpdates.get(id);
                    if (pending?.snapshot) pendingUpdates.set(id, { ...pending, snapshot: projectSnapshot(next) });
                    set((state) => ({ projects: state.projects.map((item) => item.id === id ? next : item) }));
                    if (pending) persistProjectRecovery(id);
                } catch {
                    blockedProjects.add(id);
                    const timer = saveTimers.get(id);
                    if (timer) clearTimeout(timer);
                    saveTimers.delete(id);
                    publishSaveState(id, { projectId: id, message: "同一内容被协作者修改，本地编辑已保留，请处理版本冲突", permanent: true, conflict: true });
                }
            },
            suspendProjectAccess: (id) => {
                snapshotCaptures.get(id)?.();
                const timer = saveTimers.get(id);
                if (timer) clearTimeout(timer);
                saveTimers.delete(id);
                blockedProjects.add(id);
                set((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, accessRole: "" as const } : item) }));
                publishSaveState(id, { projectId: id, message: "访问权限已变更，同步已停止；本地未保存编辑仍保留", permanent: true, conflict: pendingUpdates.has(id) || savingProjects.has(id) });
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
    serverProjects.clear();
    deferredRemoteProjects.clear();
    saveAttempts.clear();
    blockedProjects.clear();
    activeRecoveries.clear();
    recoveryWrites.clear();
    recoveryViewports.clear();
    useCanvasStore.setState({ hydrated: false, hydratedUserId: "", projects: [], projectListIds: [], projectQuery: {}, projectListLoading: false, projectListError: "", projectTotal: 0, deletedProjects: [], saveError: null, saveStates: {}, recoveries: {}, recoveryErrors: {} });
});
