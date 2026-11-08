import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CanvasRecovery } from "@/lib/canvas/canvas-recovery";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";
import { CanvasNodeType } from "@/types/canvas";

const state = vi.hoisted(() => ({
    sessionVersion: 1, userId: "A", listeners: [] as Array<(next: { sessionVersion: number }, previous: { sessionVersion: number }) => void>,
    disk: new Map<string, CanvasRecovery>(), write: vi.fn(), update: vi.fn(), read: vi.fn(), create: vi.fn(),
}));
vi.mock("localforage", () => ({ default: { createInstance: () => ({
    setItem: async (key: string, value: CanvasRecovery) => { await state.write(value); state.disk.set(key, JSON.parse(JSON.stringify(value))); },
    removeItem: async (key: string) => { state.disk.delete(key); },
    iterate: async (visit: (value: CanvasRecovery) => void) => { [...state.disk.values()].forEach(visit); },
}) } }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => ({ sessionVersion: state.sessionVersion, user: { id: state.userId } }), subscribe: (listener: typeof state.listeners[number]) => { state.listeners.push(listener); } },
    assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new DOMException("会话已变化", "AbortError"); },
}));
vi.mock("@/services/api/canvas-projects", () => ({
    updateCanvasProject: state.update, getCanvasProject: state.read, createCanvasProject: state.create,
    listCanvasProjects: async () => ({ projects: [], total: 0 }), onCanvasWorkspaceMove: () => {},
}));
const snapshot = (content = "服务端") => ({
    nodes: [{ id: "node", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});
const remote = (revision = 1): CanvasProjectDetail => ({ id: "project", title: "画布", revision, accessRole: "owner", snapshot: snapshot(), createdAt: "", updatedAt: "", nodeCount: 1, connectionCount: 0 });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const switchSession = (userId = state.userId) => { const previous = state.sessionVersion++; state.userId = userId; state.listeners.forEach((listener) => listener({ sessionVersion: state.sessionVersion }, { sessionVersion: previous })); };
async function openCanvas() {
    const { useCanvasStore: store } = await import("@/stores/canvas/use-canvas-store");
    await store.getState().hydrateProjects(state.userId);
    await store.getState().loadProject("project");
    return store;
}
const disk = () => [...state.disk.values()];

beforeEach(() => {
    vi.resetModules(); state.listeners = []; state.sessionVersion++; state.userId = "A"; state.disk.clear();
    state.write.mockReset().mockResolvedValue(undefined); state.update.mockReset(); state.read.mockReset().mockResolvedValue(remote()); state.create.mockReset();
});
afterEach(() => { switchSession(); });

test("刷新后先显示服务端，用户恢复后完整保存，并清理同版本副本", async () => {
    const first = await openCanvas();
    const local = { ...snapshot("未保存文本"), viewport: { x: 31, y: 24, k: 2 }, showImageInfo: true };
    first.getState().updateProject("project", local);
    await vi.waitFor(() => expect(disk()).toHaveLength(1));
    const recovery = disk()[0];
    expect(recovery).toMatchObject({ userId: "A", projectId: "project", baseRevision: 1, snapshot: local });
    switchSession(); vi.resetModules();
    const reopened = await openCanvas();
    expect(reopened.getState().projects[0].nodes[0].metadata.content).toBe("服务端");
    expect(reopened.getState().recoveries.project).toHaveLength(1);
    expect(state.update).not.toHaveBeenCalled();
    await reopened.getState().resolveRecovery("project", recovery.key, "restore");
    expect(reopened.getState().projects[0]).toMatchObject(local);
    state.update.mockResolvedValue({ ...remote(2), snapshot: local });
    await reopened.getState().flushProject("project");
    expect(state.update).toHaveBeenCalledWith("project", expect.objectContaining({ expectedRevision: 1, snapshot: local }));
    expect(disk()).toEqual([]);
});

test("远端已更新时拒绝原地恢复，另存完整副本保留其他标签页的恢复数据", async () => {
    const { createCanvasRecovery, writeCanvasRecovery } = await import("@/lib/canvas/canvas-recovery");
    const first = createCanvasRecovery({ userId: "A", projectId: "project", baseRevision: 1, title: "我的未保存编辑", snapshot: snapshot("我的编辑") });
    const other = createCanvasRecovery({ userId: "A", projectId: "project", baseRevision: 1, title: "其他标签页", snapshot: snapshot("其他编辑") });
    await writeCanvasRecovery(first, undefined, () => true); await writeCanvasRecovery(other, undefined, () => true);
    state.read.mockResolvedValue(remote(3));
    const store = await openCanvas();
    await expect(store.getState().resolveRecovery("project", first.key, "restore")).rejects.toThrow("远端画布版本已变化");
    expect(state.update).not.toHaveBeenCalled();
    state.read.mockRejectedValue(new Error("原画布已无法访问"));
    state.create.mockImplementation(async (input) => ({ ...remote(), id: "copy", ...input }));
    expect(await store.getState().resolveRecovery("project", first.key, "copy")).toBe("copy");
    expect(state.create).toHaveBeenCalledWith({ title: "我的未保存编辑（恢复副本）", snapshot: first.snapshot });
    expect(disk()).toEqual([other]);
});

test("迟到保存只清理已保存版本，新编辑按新基准继续保留，失败后仍可恢复", async () => {
    const store = await openCanvas();
    const first = deferred<CanvasProjectDetail>(), second = deferred<CanvasProjectDetail>();
    state.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    store.getState().updateProject("project", snapshot("第一版"));
    const saving = store.getState().flushProject("project");
    store.getState().updateProject("project", snapshot("第二版"));
    first.resolve({ ...remote(2), snapshot: snapshot("第一版") });
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    const { ApiError } = await import("@/services/api/request");
    second.reject(new ApiError("保存被拒绝", 400)); await saving;
    expect(disk()).toHaveLength(1);
    expect(disk()[0]).toMatchObject({ baseRevision: 2, snapshot: snapshot("第二版") });
    expect(store.getState().hasPendingChanges("project")).toBe(true);
});

test("缓慢本地写入在退出账号后失效，不污染新账号的副本", async () => {
    const store = await openCanvas();
    const oldWrite = deferred<void>(); state.write.mockReturnValueOnce(oldWrite.promise);
    store.getState().updateProject("project", snapshot("A私有内容"));
    await vi.waitFor(() => expect(state.write).toHaveBeenCalledOnce());
    switchSession("B"); await openCanvas();
    store.getState().updateProject("project", snapshot("B私有内容"));
    await vi.waitFor(() => expect(disk()[0]?.userId).toBe("B"));
    oldWrite.resolve();
    await vi.waitFor(() => expect(state.write).toHaveBeenCalledTimes(2));
    await new Promise(setImmediate);
    expect(disk()).toHaveLength(1);
    expect(disk()[0]).toMatchObject({ userId: "B", snapshot: snapshot("B私有内容") });
});

test("恢复读取期间的新编辑不会被恢复内容覆盖", async () => {
    const { createCanvasRecovery, writeCanvasRecovery } = await import("@/lib/canvas/canvas-recovery");
    const recovery = createCanvasRecovery({ userId: "A", projectId: "project", baseRevision: 1, title: "旧草稿", snapshot: snapshot("旧草稿") });
    await writeCanvasRecovery(recovery, undefined, () => true);
    const store = await openCanvas();
    const response = deferred<CanvasProjectDetail>(); state.read.mockReturnValueOnce(response.promise);
    const restoring = expect(store.getState().resolveRecovery("project", recovery.key, "restore")).rejects.toThrow("当前画布已有新编辑");
    store.getState().updateProject("project", snapshot("新编辑"));
    response.resolve(remote()); await restoring;
    expect(store.getState().projects[0].nodes[0].metadata.content).toBe("新编辑");
    expect(state.disk.has(recovery.key)).toBe(true);
});

test("账号重新登录仍能发现旧副本，新编辑不会静默删除待选择的旧副本", async () => {
    const store = await openCanvas();
    store.getState().updateProject("project", snapshot("退出前编辑"));
    await vi.waitFor(() => expect(disk()).toHaveLength(1));
    const previous = disk()[0];
    switchSession(); await openCanvas();
    expect(store.getState().recoveries.project[0].key).toBe(previous.key);
    store.getState().updateProject("project", snapshot("重新登录后的编辑"));
    await vi.waitFor(() => expect(disk()).toHaveLength(2));
    expect(state.disk.has(previous.key)).toBe(true);
});

test("浏览器写入失败不会阻止服务端保存，失败期间明确标记恢复不可用", async () => {
    state.write.mockRejectedValue(new Error("空间不足"));
    const store = await openCanvas();
    store.getState().updateProject("project", snapshot("待保存"));
    await vi.waitFor(() => expect(store.getState().recoveryErrors.project).toContain("写入失败"));
    state.update.mockResolvedValue({ ...remote(2), snapshot: snapshot("待保存") });
    await store.getState().flushProject("project");
    expect(store.getState().hasPendingChanges("project")).toBe(false);
    expect(disk()).toEqual([]);
});

test("选择旧副本时其他标签页的新版本已经写入，清理不会误删新版本", async () => {
    const { createCanvasRecovery, readCanvasRecoveries, writeCanvasRecovery, removeCanvasRecovery } = await import("@/lib/canvas/canvas-recovery");
    const first = createCanvasRecovery({ userId: "A", projectId: "project", baseRevision: 1, title: "第一版", snapshot: snapshot("第一版") });
    await writeCanvasRecovery(first, undefined, () => true);
    const selected = (await readCanvasRecoveries("A", "project"))[0];
    const next = createCanvasRecovery({ ...first, title: "更新版", snapshot: snapshot("更新版") }, first);
    await writeCanvasRecovery(next, first, () => true);
    await removeCanvasRecovery(selected, () => true);
    expect(disk()).toEqual([next]);
    expect(await readCanvasRecoveries("B", "project")).toEqual([]);
});

test("视口立即备份，返回已保存位置后清理无效副本，不改变服务端写入节奏", async () => {
    const store = await openCanvas();
    store.getState().retainRecovery("project", { ...snapshot(), viewport: { x: 58, y: 32, k: 2 } });
    await vi.waitFor(() => expect(disk()[0]?.snapshot?.viewport).toEqual({ x: 58, y: 32, k: 2 }));
    expect(state.update).not.toHaveBeenCalled();
    expect(store.getState().hasPendingChanges("project")).toBe(false);
    store.getState().retainRecovery("project", snapshot());
    await vi.waitFor(() => expect(disk()).toEqual([]));
});

test("仅保存标题不能清掉尚未提交视口的恢复副本", async () => {
    const store = await openCanvas();
    const viewport = { x: 80, y: 50, k: 2 };
    store.getState().retainRecovery("project", { ...snapshot(), viewport });
    await store.getState().renameProject("project", "新标题");
    state.update.mockResolvedValue({ ...remote(2), title: "新标题", snapshot: undefined });
    await store.getState().flushProject("project");
    expect(disk()).toHaveLength(1);
    expect(disk()[0]).toMatchObject({ title: "新标题", baseRevision: 2, snapshot: { viewport } });
});

test("一次本地写入失败后，后续成功会替换真正落盘的旧版，不遗留旧内容", async () => {
    const { createCanvasRecovery, writeCanvasRecovery, removeCanvasRecovery } = await import("@/lib/canvas/canvas-recovery");
    const first = createCanvasRecovery({ userId: "A", projectId: "project", baseRevision: 1, title: "第一版", snapshot: snapshot("第一版") });
    await writeCanvasRecovery(first, undefined, () => true);
    const failed = createCanvasRecovery({ ...first, title: "失败版" }, first);
    state.write.mockRejectedValueOnce(new Error("写入失败"));
    await expect(writeCanvasRecovery(failed, first, () => true)).rejects.toThrow("写入失败");
    const next = createCanvasRecovery({ ...first, title: "成功版" }, failed);
    await writeCanvasRecovery(next, failed, () => true);
    await removeCanvasRecovery(next, () => true);
    expect(disk()).toEqual([]);
});

test("崩溃遗留的同一编辑旧版本只显示最新一份，丢弃时一并清理旧版本", async () => {
    const { createCanvasRecovery, readCanvasRecoveries, removeCanvasRecovery } = await import("@/lib/canvas/canvas-recovery");
    const old = createCanvasRecovery({ userId: "A", projectId: "project", baseRevision: 1, title: "旧版", snapshot: snapshot("旧版") });
    const latest = createCanvasRecovery({ ...old, title: "新版" }, old);
    state.disk.set(old.key, old); state.disk.set(latest.key, latest);
    const recoveries = await readCanvasRecoveries("A", "project");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].key).toBe(latest.key);
    await removeCanvasRecovery(recoveries[0], () => true);
    expect(disk()).toEqual([]);
});

test("快速连续视口变化只写正在执行的版本和最新待写版本", async () => {
    const store = await openCanvas();
    const writing = deferred<void>(); state.write.mockReturnValueOnce(writing.promise);
    store.getState().retainRecovery("project", { ...snapshot(), viewport: { x: 1, y: 1, k: 1 } });
    await vi.waitFor(() => expect(state.write).toHaveBeenCalledOnce());
    for (let x = 2; x <= 20; x++) store.getState().retainRecovery("project", { ...snapshot(), viewport: { x, y: x, k: 1 } });
    expect(state.write).toHaveBeenCalledOnce();
    writing.resolve();
    await vi.waitFor(() => expect(disk()[0]?.snapshot?.viewport).toEqual({ x: 20, y: 20, k: 1 }));
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(disk()).toHaveLength(1);
    expect(state.update).not.toHaveBeenCalled();
});

test("合并待写版本期间旧保存完成仍保留未保存的新版本", async () => {
    const store = await openCanvas();
    const writing = deferred<void>(); state.write.mockReturnValueOnce(writing.promise);
    const first = deferred<CanvasProjectDetail>(), second = deferred<CanvasProjectDetail>();
    state.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    store.getState().updateProject("project", snapshot("第一版"));
    await vi.waitFor(() => expect(state.write).toHaveBeenCalledOnce());
    const saving = store.getState().flushProject("project");
    store.getState().updateProject("project", snapshot("中间版"));
    store.getState().updateProject("project", snapshot("最终编辑"));
    first.resolve({ ...remote(2), snapshot: snapshot("第一版") });
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    const { ApiError } = await import("@/services/api/request");
    second.reject(new ApiError("暂未保存", 400)); writing.resolve(); await saving;
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(disk()).toHaveLength(1);
    expect(disk()[0]).toMatchObject({ baseRevision: 2, snapshot: snapshot("最终编辑") });
});

test("恢复版本尚未开始写入就被新输入合并时，必须保留原始恢复副本", async () => {
    const { createCanvasRecovery, writeCanvasRecovery } = await import("@/lib/canvas/canvas-recovery");
    const recovery = createCanvasRecovery({ userId: "A", projectId: "project", baseRevision: 1, title: "恢复来源", snapshot: snapshot("待恢复文本") });
    await writeCanvasRecovery(recovery, undefined, () => true);
    const store = await openCanvas();
    const writing = deferred<void>(); state.write.mockReturnValueOnce(writing.promise).mockRejectedValueOnce(new Error("空间不足"));
    store.getState().retainRecovery("project", { ...snapshot(), viewport: { x: 1, y: 1, k: 1 } });
    await vi.waitFor(() => expect(state.write).toHaveBeenCalledTimes(2));
    const restoring = expect(store.getState().resolveRecovery("project", recovery.key, "restore")).rejects.toThrow("原恢复副本");
    await vi.waitFor(() => expect(store.getState().projects[0].nodes[0].metadata.content).toBe("待恢复文本"));
    store.getState().updateProject("project", snapshot("恢复后的新编辑"));
    writing.resolve(); await restoring;
    await vi.waitFor(() => expect(store.getState().recoveryErrors.project).toContain("写入失败"));
    expect(state.disk.has(recovery.key)).toBe(true);
    expect(store.getState().projects[0].nodes[0].metadata.content).toBe("恢复后的新编辑");
});

test("最新版本在待写期间已保存，合并跳过后仍清理同一编辑链的落盘旧版", async () => {
    const store = await openCanvas();
    store.getState().updateProject("project", snapshot("已落盘旧版"));
    await vi.waitFor(() => expect(disk()).toHaveLength(1));
    const writing = deferred<void>(); state.write.mockReturnValueOnce(writing.promise);
    store.getState().updateProject("project", snapshot("慢速写入版"));
    await vi.waitFor(() => expect(state.write).toHaveBeenCalledTimes(2));
    store.getState().updateProject("project", snapshot("已保存最新版"));
    state.update.mockResolvedValue({ ...remote(2), snapshot: snapshot("已保存最新版") });
    const saving = store.getState().flushProject("project");
    await vi.waitFor(() => expect(store.getState().saveStates.project.phase).toBe("saved"));
    writing.resolve(); await saving;
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(disk()).toEqual([]);
});
