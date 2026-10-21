import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "antd";
import { useState } from "react";
import { transferableAbortController } from "node:util";
import { createMemoryRouter, RouterProvider, useParams } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const state = vi.hoisted(() => ({
    sessionVersion: 1, pending: false, enabled: true, projects: [] as CanvasProject[],
    updateProject: vi.fn(), flushProject: vi.fn(), capture: undefined as undefined | (() => void),
}));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => state } }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: { getState: () => ({ ...state, hasPendingChanges: () => state.pending, registerSnapshotCapture: (_id: string, capture: () => void) => { state.capture = capture; return () => { state.capture = undefined; }; } }) } }));
import { useCanvasPersistence } from "@/pages/canvas/hooks/use-canvas-persistence";

const snapshot = () => ({ nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } });
let value: ReturnType<typeof snapshot>;
let router: ReturnType<typeof createMemoryRouter>;

function CanvasPage() {
    const { id } = useParams();
    const [, redraw] = useState(0);
    useCanvasPersistence(id!, state.enabled, value);
    return <button onClick={() => redraw((current) => current + 1)}>重绘画布</button>;
}

function mount() {
    router = createMemoryRouter([
        { path: "/canvas/:id", element: <CanvasPage /> },
        { path: "/assets", element: <p>素材页面</p> },
    ], { initialEntries: ["/canvas/project"] });
    return render(<App><RouterProvider router={router} /></App>);
}

beforeEach(() => {
    value = snapshot();
    state.sessionVersion = 1; state.pending = false; state.enabled = true;
    state.projects = [{ id: "project", snapshotLoaded: true, accessRole: "owner", ...value } as CanvasProject];
    state.updateProject.mockReset().mockImplementation((id, patch) => { Object.assign(state.projects.find((item) => item.id === id)!, patch); state.pending = true; });
    state.flushProject.mockReset().mockImplementation(async () => { state.pending = false; });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    // React Router 的 Request 使用 Node fetch，须匹配同一运行时的 signal。
    vi.stubGlobal("AbortController", transferableAbortController().constructor);
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); router?.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("关页前把尚未入队的视口一起保存，未保存时触发浏览器提示", async () => {
    value = { ...value, viewport: { x: 80, y: 12, k: 2 } };
    let complete!: () => void;
    state.flushProject.mockImplementation(() => new Promise<void>((resolve) => { complete = () => { state.pending = false; resolve(); }; }));
    mount();
    const event = new Event("beforeunload", { cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(state.updateProject).toHaveBeenCalledWith("project", { viewport: { x: 80, y: 12, k: 2 } });
    await act(async () => complete());
    const clean = new Event("beforeunload", { cancelable: true });
    act(() => window.dispatchEvent(clean));
    expect(clean.defaultPrevented).toBe(false);
});

test("真实路由导航等待保存完成，然后自动进入目标页面", async () => {
    state.pending = true;
    let complete!: () => void;
    state.flushProject.mockImplementation(() => new Promise<void>((resolve) => { complete = () => { state.pending = false; resolve(); }; }));
    mount();
    await act(async () => { await router.navigate("/assets"); });
    expect(router.state.location.pathname).toBe("/canvas/project");
    expect(state.flushProject).toHaveBeenCalledWith("project");
    await act(async () => complete());
    expect(await screen.findByText("素材页面")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/assets");
});

test("保存失败留在画布，重渲染不重复提示，继续编辑解除导航拦截", async () => {
    state.pending = true;
    state.flushProject.mockRejectedValue(new Error("保存失败"));
    const user = userEvent.setup();
    mount();
    await act(async () => { await router.navigate("/assets"); });
    expect(await screen.findByRole("dialog", { name: "画布尚未保存" })).toBeInTheDocument();
    await user.click(screen.getByText("重绘画布"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(state.flushProject).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(Array.from(router.state.blockers.values())[0]?.state).toBe("unblocked"));
    expect(router.state.location.pathname).toBe("/canvas/project");
    expect(state.pending).toBe(true);
});

test("存在冲突时明确选择离开才进入目标页面", async () => {
    state.pending = true;
    state.flushProject.mockResolvedValue(undefined);
    mount();
    await act(async () => { await router.navigate("/assets"); });
    await userEvent.click(await screen.findByRole("button", { name: "仍然离开" }));
    expect(await screen.findByText("素材页面")).toBeInTheDocument();
    expect(state.pending).toBe(true);
});

test("卸载时合入尚未入队的视口，保存离开的项目", () => {
    value = { ...value, viewport: { x: 19, y: 30, k: 1 } };
    const view = mount();
    view.unmount();
    expect(state.updateProject).toHaveBeenCalledWith("project", { viewport: value.viewport });
    expect(state.flushProject).toHaveBeenCalledWith("project");
});

test("冲突处理读取快照前合入最新视口，不额外发起保存", () => {
    value = { ...value, viewport: { x: 99, y: 11, k: 2 } };
    mount();
    act(() => state.capture?.());
    expect(state.projects[0].viewport).toEqual(value.viewport);
    expect(state.updateProject).toHaveBeenCalledWith("project", { viewport: value.viewport });
    expect(state.flushProject).not.toHaveBeenCalled();
});

test("viewer 与已切换的登录会话不保存旧快照", async () => {
    state.projects[0].accessRole = "viewer";
    state.enabled = false;
    value = { ...value, viewport: { x: 90, y: 0, k: 1 } };
    mount();
    act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    state.projects[0].accessRole = "owner";
    state.enabled = true;
    await userEvent.click(screen.getByText("重绘画布"));
    state.sessionVersion++;
    act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    expect(state.updateProject).not.toHaveBeenCalled();
    expect(state.flushProject).not.toHaveBeenCalled();
});
