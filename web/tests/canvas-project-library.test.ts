import { createRequire } from "node:module";
import { expect, test, vi } from "vitest";
import { loadModule, readSource } from "./support/source-loader";

const nodeRequire = createRequire(import.meta.url);
const record = (id: string, title = id) => ({ id, title, revision: 0, nodeCount: 0, connectionCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", accessRole: "owner", canDelete: true, coverUrl: `/api/media/${id}` });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
}

function setup(t: { onTestFinished: (fn: () => void) => void }) {
    const zustand = nodeRequire("zustand");
    const user = zustand.create(() => ({ user: { id: "user" }, sessionVersion: 1 }));
    const api = { __esModule: true, onCanvasWorkspaceMove: () => {}, listCanvasProjects: vi.fn(), getCanvasProject: vi.fn() };
    const module = loadModule(readSource("stores/canvas/use-canvas-store.ts"), { DOMException, setTimeout, clearTimeout }, {
        zustand,
        "@/i18n": { __esModule: true, default: { t: (key: string) => key } },
        "@/services/api/canvas-projects": api,
        "@/services/api/request": { ApiError: class extends Error {} },
        "@/stores/use-user-store": { useUserStore: user, assertCurrentSession: (version: number) => { if (version !== user.getState().sessionVersion) throw new DOMException("登录会话已变更", "AbortError"); } },
    });
    const canvas = module.useCanvasStore;
    t.onTestFinished(() => user.setState({ sessionVersion: user.getState().sessionVersion + 1 }));
    return { api, canvas, user };
}

test("较早搜索的迟到结果不会覆盖新的筛选列表", async (t) => {
    const { api, canvas } = setup(t);
    const earlier = deferred<{ projects: ReturnType<typeof record>[]; total: number }>();
    const later = deferred<{ projects: ReturnType<typeof record>[]; total: number }>();
    api.listCanvasProjects.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    const oldRequest = canvas.getState().refreshProjectList({ keyword: "旧关键词" });
    const newRequest = canvas.getState().refreshProjectList({ keyword: "新关键词" });
    later.resolve({ projects: [record("new")], total: 1 });
    await newRequest;
    earlier.resolve({ projects: [record("old")], total: 30 });
    await oldRequest;
    expect(canvas.getState().projectListIds).toEqual(["new"]);
    expect(canvas.getState().projectTotal).toBe(1);
    expect(canvas.getState().projectListLoading).toBe(false);
    expect(canvas.getState().projectQuery.keyword).toBe("新关键词");
});

test("筛选保留尚未保存的完整快照，加载更多以筛选列表长度作为offset", async (t) => {
    const { api, canvas } = setup(t);
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [record("editing")], total: 1 });
    api.getCanvasProject.mockResolvedValue({ ...record("editing"), snapshot: { nodes: [], connections: [] } });
    await canvas.getState().hydrateProjects("user");
    await canvas.getState().loadProject("editing");
    const nodes = [{ id: "local", type: "text", metadata: { content: "尚未保存" } }];
    canvas.getState().updateProject("editing", { nodes });
    const query = { keyword: "海报", workspaceId: "workspace", sort: "created_asc" };
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [record("first")], total: 2 });
    await canvas.getState().refreshProjectList(query);
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [record("second")], total: 2 });
    await canvas.getState().loadMoreProjects();
    expect(api.listCanvasProjects).toHaveBeenLastCalledWith(1, query);
    expect(canvas.getState().projectListIds).toEqual(["first", "second"]);
    expect(canvas.getState().projects.find((project: { id: string }) => project.id === "editing").nodes).toEqual(nodes);
    expect(canvas.getState().hasPendingChanges("editing")).toBe(true);
});

test("元数据刷新不把保留的完整快照标记为服务端新版本", async (t) => {
    const { api, canvas } = setup(t);
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [record("project")], total: 1 });
    api.getCanvasProject.mockResolvedValue({ ...record("project"), snapshot: { nodes: [{ id: "original" }], connections: [] } });
    await canvas.getState().hydrateProjects("user");
    await canvas.getState().loadProject("project");
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [{ ...record("project", "远端标题"), revision: 9, coverUrl: "/api/media/new-cover" }], total: 1 });
    await canvas.getState().refreshProjectList();
    const project = canvas.getState().projects[0];
    expect(project.snapshotLoaded).toBe(true);
    expect(project.nodes[0].id).toBe("original");
    expect(project.revision).toBe(0);
    expect(project.title).toBe("远端标题");
    expect(project.coverUrl).toBe("/api/media/new-cover");
});

test("回到首页可刷新无筛选的真实最新顺序，旧筛选快照仍在缓存中", async (t) => {
    const { api, canvas } = setup(t);
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [record("recent")], total: 1 });
    await canvas.getState().hydrateProjects("user");
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [record("filtered")], total: 1 });
    await canvas.getState().refreshProjectList({ keyword: "旧项目" });
    api.listCanvasProjects.mockResolvedValueOnce({ projects: [record("newest"), record("recent")], total: 2 });
    await canvas.getState().refreshProjectList({});
    expect(api.listCanvasProjects).toHaveBeenLastCalledWith(0, {});
    expect(canvas.getState().projectListIds).toEqual(["newest", "recent"]);
    expect(canvas.getState().projects.map((project: { id: string }) => project.id)).toContain("filtered");
});

test("切换登录会话后，迟到的列表响应不写回另一位用户的缓存", async (t) => {
    const { api, canvas, user } = setup(t);
    const pending = deferred<{ projects: ReturnType<typeof record>[]; total: number }>();
    api.listCanvasProjects.mockReturnValueOnce(pending.promise);
    const request = canvas.getState().refreshProjectList({ keyword: "私有画布" });
    const rejected = expect(request).rejects.toThrow("登录会话已变更");
    user.setState({ user: { id: "other-user" }, sessionVersion: 2 });
    pending.resolve({ projects: [record("private")], total: 1 });
    await rejected;
    expect(canvas.getState().projects).toEqual([]);
    expect(canvas.getState().projectListIds).toEqual([]);
    expect(canvas.getState().projectTotal).toBe(0);
    expect(canvas.getState().projectListLoading).toBe(false);
});
