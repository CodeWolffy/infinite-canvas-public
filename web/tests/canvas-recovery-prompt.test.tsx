import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, ConfigProvider } from "antd";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ sessionVersion: 1, revision: 1, resolve: vi.fn(), navigate: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => state.navigate }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }),
    assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new Error("会话已变化"); },
}));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: Object.assign((select: (value: unknown) => unknown) => select({
    projects: [{ id: "project", revision: state.revision, snapshotLoaded: true, accessRole: "owner" }],
    recoveries: { project: [{ key: "draft", title: "待恢复内容", baseRevision: 1, savedAt: "2026-01-01T12:00:00Z", snapshot: { nodes: [] } }] },
}), { getState: () => ({ resolveRecovery: state.resolve }) }) }));
const { CanvasRecoveryPrompt } = await import("@/components/canvas/canvas-recovery-prompt");
const mount = () => render(<ConfigProvider theme={{ token: { motion: false } }}><App><CanvasRecoveryPrompt projectId="project" /></App></ConfigProvider>);

beforeEach(() => {
    state.sessionVersion = 1; state.revision = 1; state.resolve.mockReset().mockResolvedValue("project"); state.navigate.mockReset();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("自动提示但不自动恢复，稍后处理后可从画布入口重新打开并确认", async () => {
    mount();
    expect(await screen.findByRole("dialog", { name: "发现未保存的画布内容" })).toBeInTheDocument();
    expect(state.resolve).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "恢复未保存内容" }));
    await userEvent.click(await screen.findByRole("button", { name: "恢复到当前画布" }));
    expect(state.resolve).toHaveBeenCalledWith("project", "draft", "restore");
});

test("远端版本更新时禁用原地恢复，另存后进入新画布", async () => {
    state.revision = 3; state.resolve.mockResolvedValue("copy");
    mount();
    expect(screen.getByRole("button", { name: "恢复到当前画布" })).toBeDisabled();
    expect(screen.getByText("远端版本或编辑权限已变化，请另存恢复副本。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "另存恢复副本" }));
    expect(state.resolve).toHaveBeenCalledWith("project", "draft", "copy");
    expect(state.navigate).toHaveBeenCalledWith("/canvas/copy");
});

test("恢复失败保留弹窗并说明原因，允许用户继续处理", async () => {
    state.resolve.mockRejectedValue(new Error("远端画布版本已变化"));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "恢复到当前画布" }));
    expect(await screen.findByText("远端画布版本已变化")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(state.navigate).not.toHaveBeenCalled();
});
