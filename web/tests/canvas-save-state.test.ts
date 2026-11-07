import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";

const state = vi.hoisted(() => ({ sessionVersion: 1, listener: (_next: { sessionVersion: number }, _previous: { sessionVersion: number }) => {}, move: (_record: CanvasProjectDetail) => {}, update: vi.fn(), remove: vi.fn(), read: vi.fn() }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => ({ sessionVersion: state.sessionVersion, user: { id: "user" } }), subscribe: (listener: typeof state.listener) => { state.listener = listener; } },
    assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new DOMException("会话已变化", "AbortError"); },
}));
vi.mock("@/services/api/canvas-projects", () => ({
    updateCanvasProject: state.update, deleteCanvasProject: state.remove, getCanvasProject: state.read,
    listCanvasProjects: async () => ({ projects: [], total: 0 }),
    onCanvasWorkspaceMove: (listener: typeof state.move) => { state.move = listener; },
}));
const { useCanvasStore: store } = await import("@/stores/canvas/use-canvas-store");
const { ApiError } = await import("@/services/api/request");
const record = (id: string, revision = 1): CanvasProjectDetail => ({ id, title: id, revision, createdAt: "", updatedAt: "", nodeCount: 0, connectionCount: 0, accessRole: "owner", snapshot: {} });
const switchSession = () => { const previous = state.sessionVersion++; state.listener({ sessionVersion: state.sessionVersion }, { sessionVersion: previous }); };
const deferred = () => { let resolve!: (value: CanvasProjectDetail) => void; let reject!: (error: Error) => void; const promise = new Promise<CanvasProjectDetail>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => {
    switchSession();
    state.update.mockReset(); state.remove.mockReset().mockResolvedValue(undefined); state.read.mockReset();
    store.setState({ hydrated: true, hydratedUserId: "user" });
    store.getState().adoptProject(record("a")); store.getState().adoptProject(record("b"));
});
afterEach(() => { switchSession(); vi.useRealTimers(); });

test("入队待保存，请求期间继续编辑，后续请求完成前不能显示已保存", async () => {
    const first = deferred(), second = deferred();
    state.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const phases: string[] = [];
    const unsubscribe = store.subscribe((value) => { const phase = value.saveStates.a?.phase; if (phase) phases.push(phase); });
    store.getState().updateProject("a", { viewport: { x: 1, y: 0, k: 1 } });
    expect(store.getState().saveStates.a.phase).toBe("pending");
    const saving = store.getState().flushProject("a");
    expect(store.getState().saveStates.a.phase).toBe("saving");
    store.getState().updateProject("a", { viewport: { x: 2, y: 0, k: 1 } });
    first.resolve(record("a", 2));
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(phases).not.toContain("saved");
    expect(store.getState().saveStates.a.phase).toBe("saving");
    second.resolve(record("a", 3)); await saving;
    expect(store.getState().saveStates.a.phase).toBe("saved");
    expect(store.getState().hasPendingChanges("a")).toBe(false);
    unsubscribe();
});

test("错误按画布隔离，其他项目的失败不解除本画布冲突，手动重试沿用原队列", async () => {
    state.update.mockRejectedValueOnce(new ApiError("a冲突", 409)).mockRejectedValueOnce(new ApiError("b失败", 400));
    await store.getState().renameProject("a", "a本地"); await store.getState().flushProject("a");
    await store.getState().renameProject("b", "b本地"); await store.getState().flushProject("b");
    expect(store.getState().saveStates.a.error?.message).toBe("a冲突");
    expect(store.getState().saveStates.b.error?.message).toBe("b失败");
    await store.getState().retrySave("a");
    expect(state.update).toHaveBeenCalledTimes(2);
    const retry = deferred(); state.update.mockReturnValueOnce(retry.promise);
    const saving = store.getState().retrySave("b");
    expect(store.getState().saveStates.b.phase).toBe("saving");
    retry.resolve(record("b", 2)); await saving;
    expect(store.getState().saveStates.b).toMatchObject({ phase: "saved", error: null });
    expect(store.getState().saveStates.a.error?.conflict).toBe(true);
    state.read.mockResolvedValue(record("a", 3));
    await store.getState().resolveConflict("a", "reload");
    expect(store.getState().saveStates.a).toMatchObject({ phase: "saved", error: null });
});

test("请求失败按原退避重试，等待重试仍待保存，请求开始显示保存中", async () => {
    vi.useFakeTimers();
    const retry = deferred();
    state.update.mockRejectedValueOnce(new Error("网络中断")).mockReturnValueOnce(retry.promise);
    await store.getState().renameProject("a", "本地"); await store.getState().flushProject("a");
    expect(store.getState().saveStates.a).toMatchObject({ phase: "pending", error: { permanent: false } });
    await vi.advanceTimersByTimeAsync(1999); expect(state.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(state.update).toHaveBeenCalledTimes(2);
    expect(store.getState().saveStates.a.phase).toBe("saving");
    retry.resolve(record("a", 2)); await store.getState().flushProject("a");
    expect(store.getState().saveStates.a).toMatchObject({ phase: "saved", error: null });
});

test("切换账号清除保存状态，旧请求完成不能清除新会话正在保存的状态", async () => {
    const old = deferred(), next = deferred();
    state.update.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await store.getState().renameProject("a", "旧会话"); const savingOld = store.getState().flushProject("a");
    switchSession(); expect(store.getState().saveStates).toEqual({});
    store.setState({ hydrated: true }); store.getState().adoptProject(record("a"));
    await store.getState().renameProject("a", "新会话"); const savingNext = store.getState().flushProject("a");
    old.reject(new Error("旧失败")); await savingOld;
    expect(store.getState().saveStates.a).toMatchObject({ phase: "saving", error: null, sessionVersion: state.sessionVersion });
    next.resolve(record("a", 2)); await savingNext;
    expect(store.getState().saveStates.a.phase).toBe("saved");
});

test("删除等待正在保存的请求，删除完成不残留保存状态或迟到错误", async () => {
    const response = deferred(); state.update.mockReturnValueOnce(response.promise);
    await store.getState().renameProject("a", "待删除"); const saving = store.getState().flushProject("a");
    const deleting = store.getState().deleteProjects(["a"]);
    expect(store.getState().saveStates.a.phase).toBe("saving");
    response.reject(new Error("已删除")); await Promise.all([saving, deleting]);
    expect(store.getState().saveStates.a).toBeUndefined();
    expect(store.getState().projects.some((item) => item.id === "a")).toBe(false);
    expect(store.getState().saveError).toBeNull();
});

test("请求期间工作区变更触发本项目冲突，迟到成功不能把它标为已保存", async () => {
    const response = deferred(); state.update.mockReturnValueOnce(response.promise);
    await store.getState().renameProject("a", "本地"); const saving = store.getState().flushProject("a");
    state.move({ ...record("a", 2), workspaceId: "workspace" });
    response.resolve(record("a", 2)); await saving;
    expect(store.getState().saveStates.a).toMatchObject({ phase: "pending", error: { conflict: true } });
});

test("工作区冲突拦截迟到成功后，重新接纳远端详情仍保留本地快照和未保存状态", async () => {
    const response = deferred(); state.update.mockReturnValueOnce(response.promise);
    const local = { x: 80, y: 20, k: 2 };
    store.getState().updateProject("a", { viewport: local });
    const saving = store.getState().flushProject("a");
    state.move({ ...record("a", 2), workspaceId: "workspace" });
    response.resolve(record("a", 2)); await saving;
    store.getState().adoptProject({ ...record("a", 3), snapshot: { viewport: { x: 0, y: 0, k: 1 } } });
    expect(store.getState().projects.find((project) => project.id === "a")?.viewport).toEqual(local);
    expect(store.getState().saveStates.a).toMatchObject({ phase: "pending", error: { conflict: true } });
    await store.getState().loadProject("a");
    expect(state.read).not.toHaveBeenCalled();
    store.getState().applyRestoredProject(record("a", 4));
    expect(store.getState().saveStates.a).toMatchObject({ phase: "saved", error: null });
});
