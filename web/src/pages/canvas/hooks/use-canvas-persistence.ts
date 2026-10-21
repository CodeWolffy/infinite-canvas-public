import { useCallback, useEffect, useRef } from "react";
import { useBlocker, type BlockerFunction } from "react-router-dom";
import { App } from "antd";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

type Snapshot = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">;
type SaveScope = { projectId: string; enabled: boolean; snapshot: Snapshot; session: number };

export function useCanvasPersistence(projectId: string, enabled: boolean, snapshot: Snapshot) {
    const { modal } = App.useApp();
    const session = useUserStore.getState().sessionVersion;
    const latest = useRef<SaveScope>({ projectId, enabled, snapshot, session });
    if (latest.current.projectId !== projectId || latest.current.session !== session) latest.current = { projectId, enabled, snapshot, session };
    else Object.assign(latest.current, { enabled, snapshot });

    const changes = useCallback((current = latest.current) => {
        const store = useCanvasStore.getState();
        const project = store.projects.find((item) => item.id === current.projectId);
        if (!current.enabled || current.session !== useUserStore.getState().sessionVersion || !project?.snapshotLoaded || project.accessRole === "viewer") return null;
        const patch = Object.fromEntries(Object.entries(current.snapshot).filter(([key, value]) => project[key as keyof Snapshot] !== value)) as Partial<Snapshot>;
        return { current, store, patch };
    }, []);
    const dirty = useCallback(() => {
        const value = changes();
        return Boolean(value && (Object.keys(value.patch).length || value.store.hasPendingChanges(value.current.projectId)));
    }, [changes]);
    const flush = useCallback(async (current = latest.current) => {
        const value = changes(current);
        if (!value) return;
        if (Object.keys(value.patch).length) value.store.updateProject(value.current.projectId, value.patch);
        await value.store.flushProject(value.current.projectId);
    }, [changes]);
    const blocker = useBlocker(useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && dirty(), [dirty]));
    const blockerRef = useRef(blocker);
    blockerRef.current = blocker;

    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!dirty()) return;
            void flush().catch(() => undefined);
            event.preventDefault();
            event.returnValue = "";
        };
        const visibility = () => { if (document.visibilityState === "hidden") void flush().catch(() => undefined); };
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("visibilitychange", visibility);
        return () => {
            window.removeEventListener("beforeunload", beforeUnload);
            document.removeEventListener("visibilitychange", visibility);
        };
    }, [dirty, flush]);

    useEffect(() => {
        // 清理时保存离开的画布，不能读到新路由的项目与快照。
        const current = latest.current;
        const unregister = useCanvasStore.getState().registerSnapshotCapture(projectId, () => {
            const value = changes(current);
            if (value && Object.keys(value.patch).length) value.store.updateProject(current.projectId, value.patch);
        });
        return () => { unregister(); void flush(current).catch(() => undefined); };
    }, [projectId, session, changes, flush]);

    useEffect(() => {
        if (blocker.state !== "blocked") return;
        let disposed = false;
        let dialog: ReturnType<typeof modal.confirm> | undefined;
        const finish = () => {
            if (disposed) return;
            const current = blockerRef.current;
            if (current.state !== "blocked") return;
            if (!dirty()) { current.proceed(); return; }
            dialog = modal.confirm({
                title: "画布尚未保存",
                content: "保存失败或存在版本冲突。继续编辑可以处理保存问题；离开后本地编辑仍保留在当前标签页，刷新前请先保存。",
                okText: "继续编辑", cancelText: "仍然离开", closable: false, mask: { closable: false }, keyboard: false,
                onOk: () => { if (blockerRef.current.state === "blocked") blockerRef.current.reset(); },
                onCancel: () => { if (blockerRef.current.state === "blocked") blockerRef.current.proceed(); },
            });
        };
        void flush().then(finish, finish);
        return () => { disposed = true; dialog?.destroy(); };
    }, [blocker.state, blocker.location?.key, dirty, flush, modal]);
}
