import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { CanvasSaveState } from "@/stores/canvas/use-canvas-store";

const state = vi.hoisted(() => ({ id: "a", sessionVersion: 1, retry: vi.fn(), saveStates: {} as Record<string, CanvasSaveState> }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ id: state.id }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ({ "workspace.readOnlyBadge": "只读", "canvas.save.blocked": "保存失败，点击重试", "canvas.save.retrying": "保存失败，正在重试" })[key] || key }) }));
vi.mock("antd", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children, theme: { useToken: () => ({ token: { colorError: "red" } }) } }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: (select: (value: { theme: string }) => unknown) => select({ theme: "light" }) }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: (select: (value: unknown) => unknown) => select({ projects: ["a", "b"].map((id) => ({ id, snapshotLoaded: true, accessRole: "owner" })), saveStates: state.saveStates, retrySave: state.retry }) }));
vi.mock("@/components/canvas/canvas-save-conflict-modal", () => ({ CanvasSaveConflictModal: ({ projectId, open }: { projectId: string; open: boolean }) => open ? <div role="dialog">{projectId}冲突</div> : null }));
const { CanvasSaveStatus } = await import("@/components/canvas/canvas-save-status");
afterEach(() => { cleanup(); state.id = "a"; state.sessionVersion = 1; state.saveStates = {}; state.retry.mockClear(); });

test("排队与本地未入队编辑显示待保存，请求中显示保存中，全部完成才显示已保存", () => {
    const view = render(<CanvasSaveStatus hasLocalChanges />);
    expect(screen.getByRole("status")).toHaveTextContent("待保存");
    state.saveStates.a = { phase: "saving", error: null, sessionVersion: 1 };
    view.rerender(<CanvasSaveStatus hasLocalChanges />);
    expect(screen.getByRole("status")).toHaveTextContent("保存中");
    state.saveStates.a.phase = "pending";
    view.rerender(<CanvasSaveStatus />);
    expect(screen.getByRole("status")).toHaveTextContent("待保存");
    state.saveStates.a.phase = "saved";
    view.rerender(<CanvasSaveStatus />);
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
});

test("切换画布不携带另一画布错误或已打开的冲突弹窗，重试只针对当前画布", () => {
    state.saveStates.a = { phase: "pending", error: { projectId: "a", message: "a冲突", permanent: true, conflict: true }, sessionVersion: 1 };
    state.saveStates.b = { phase: "pending", error: { projectId: "b", message: "b失败", permanent: true }, sessionVersion: 1 };
    const view = render(<CanvasSaveStatus />);
    fireEvent.click(screen.getByRole("button", { name: "处理画布冲突" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("a冲突");
    state.id = "b"; view.rerender(<CanvasSaveStatus />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存失败，点击重试" }));
    expect(state.retry).toHaveBeenCalledWith("b");
    state.id = "a"; view.rerender(<CanvasSaveStatus />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("只读画布不显示保存按钮，旧会话错误不会进入当前状态", () => {
    state.saveStates.a = { phase: "pending", error: { projectId: "a", message: "失败", permanent: true }, sessionVersion: 1 };
    const view = render(<CanvasSaveStatus readOnly />);
    expect(screen.getByText("只读")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    state.sessionVersion = 2; view.rerender(<CanvasSaveStatus hasLocalChanges />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("待保存");
});
