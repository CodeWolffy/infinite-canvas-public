import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { App } from "antd";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("@/services/api/canvas-projects", () => ({ listCanvasProjects: api.list }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: { getState: () => ({ createProject: api.create }) } }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    return { useUserStore: create(() => ({ sessionVersion: 1, user: { id: "user" } })) };
});
import { AddToCanvasModal } from "@/components/canvas/add-to-canvas-modal";
import { useCanvasHandoffStore } from "@/stores/canvas/use-canvas-handoff-store";

function Host() {
    const location = useLocation();
    return <><output data-testid="location">{location.pathname}</output><AddToCanvasModal /></>;
}
function mount() {
    useCanvasHandoffStore.getState().open([{ kind: "text", title: "测试文案", content: "内容" }], "source");
    return render(<App><MemoryRouter initialEntries={["/image"]}><Host /></MemoryRouter></App>);
}
beforeEach(() => {
    api.list.mockReset().mockResolvedValue({ projects: [{ id: "editable", title: "可编辑画布", accessRole: "editor", nodeCount: 2 }, { id: "readonly", title: "只读画布", accessRole: "viewer", nodeCount: 1 }], total: 2 });
    api.create.mockReset().mockResolvedValue("new-canvas");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); useCanvasHandoffStore.getState().cancel(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("只读画布不能选，确认已有画布携带待插入内容进入正确目标", async () => {
    mount();
    expect(await screen.findByRole("button", { name: /只读画布/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /可编辑画布/ }));
    fireEvent.click(screen.getByRole("button", { name: "加入所选画布" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/canvas/editable"));
    expect(useCanvasHandoffStore.getState().request).toMatchObject({ projectId: "editable", items: [{ content: "内容" }] });
    expect(api.create).not.toHaveBeenCalled();
});

test("新建画布采用输入标题，创建成功后携带交接", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "新建画布" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新画布名称" }), { target: { value: "商品方案" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并加入" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/canvas/new-canvas"));
    expect(api.create).toHaveBeenCalledExactlyOnceWith("商品方案");
});

test("创建期间取消交接，迟到响应不会导航或重新加入", async () => {
    let resolve!: (id: string) => void;
    api.create.mockReturnValue(new Promise((done) => { resolve = done; }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "新建画布" }));
    fireEvent.click(screen.getByRole("button", { name: "创建并加入" }));
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    await act(async () => resolve("late-canvas"));
    expect(screen.getByTestId("location")).toHaveTextContent("/image");
    expect(useCanvasHandoffStore.getState().request).toBeNull();
});
