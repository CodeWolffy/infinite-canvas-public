import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const currentSession = vi.hoisted(() => ({ sessionVersion: 1, user: { id: "self" } }));
vi.mock("@/services/api/generation", () => ({ GENERATION_PAGE_SIZE: 50 }));
vi.mock("@/stores/use-user-store", () => {
    return { assertCurrentSession: vi.fn(), useUserStore: Object.assign((selector: (state: typeof currentSession) => unknown) => selector(currentSession), { getState: () => currentSession }) };
});
vi.mock("@/services/api/user-tasks", async (importOriginal) => ({ ...await importOriginal<typeof import("@/services/api/user-tasks")>(), getUserGenerationTasks: vi.fn() }));

import GenerationTaskCenter from "@/components/layout/generation-task-center";
import { getUserGenerationTasks, type UserGenerationTask, type UserGenerationTaskPage } from "@/services/api/user-tasks";

const clients: QueryClient[] = [];
const task = (fields: Partial<UserGenerationTask> = {}): UserGenerationTask => ({ id: "task", capability: "text", batchId: null, canvasProjectId: null, conversationId: "conversation", prompt: "测试文本任务", sourceTitle: "文本对话", sourceUnavailable: null, status: "queued", sequence: 0, queuedAt: "2026-10-01T00:00:00Z", startedAt: null, finishedAt: null, modelName: null, modelDisplayName: "测试模型", errorCode: null, errorMessage: null, ...fields });
const page = (tasks: UserGenerationTask[] = []): UserGenerationTaskPage => ({ tasks, total: tasks.length, limit: 50, offset: 0, summary: { reviewing: 0, queued: 1, running: 0 } });

function showCenter() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    clients.push(client);
    const center = () => <MemoryRouter><QueryClientProvider client={client}><GenerationTaskCenter onClose={vi.fn()} /></QueryClientProvider></MemoryRouter>;
    const view = render(center());
    return { rerender: () => view.rerender(center()) };
}

beforeAll(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
beforeEach(() => {
    vi.mocked(getUserGenerationTasks).mockReset();
    currentSession.sessionVersion = 1;
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals(); });

test("任务中心展示服务端概况、音频预览，并隐藏失效画布的提示词与媒体", async () => {
    vi.mocked(getUserGenerationTasks).mockResolvedValue(page([
        task(),
        task({ id: "audio", capability: "audio", conversationId: null, sourceTitle: null, prompt: "测试音频任务", status: "succeeded", output: { mediaId: "audio-result", url: "/api/media/audio-result", mimeType: "audio/mpeg", bytes: 1 } }),
        task({ id: "revoked", capability: "image", conversationId: null, canvasProjectId: "revoked-canvas", sourceUnavailable: "canvas", sourceTitle: "不能显示的画布名", prompt: "不能显示的提示词", errorMessage: "不能显示的私有错误", output: { mediaId: "hidden", url: "/api/media/hidden", mimeType: "image/png", bytes: 1 } }),
        task({ id: "deleted", sourceUnavailable: "conversation", sourceTitle: "不能显示的对话名", prompt: "不能显示的对话内容" }),
    ]));
    showCenter();
    await screen.findByText("测试音频任务");
    expect(screen.getByLabelText("音频生成结果").getAttribute("src")).toBe("/api/media/audio-result");
    const overview = screen.getByRole("group", { name: "进行中任务概况" });
    expect(overview.textContent).toContain("审核中 0");
    expect(overview.textContent).toContain("排队中 1");
    expect(overview.textContent).toContain("生成中 0");
    expect(screen.getByText("来源画布已不可访问，内容已隐藏")).toBeTruthy();
    expect(screen.queryByText("不能显示的提示词")).toBeNull();
    expect(screen.queryByText("不能显示的私有错误")).toBeNull();
    expect(screen.queryByText("不能显示的画布名")).toBeNull();
    expect(screen.queryByText("不能显示的对话名")).toBeNull();
    expect(screen.queryByText("不能显示的对话内容")).toBeNull();
    expect(screen.queryByAltText("生成结果")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^查看(?:画布|对话|批次)/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "查看对话 · 文本对话" })).toBeTruthy();
});

test("任务读取错误保留清晰提示，用户可通过刷新再次读取", async () => {
    vi.mocked(getUserGenerationTasks).mockRejectedValueOnce(new Error("连接暂时中断")).mockResolvedValueOnce(page([task()]));
    showCenter();
    await screen.findByText("任务读取失败");
    expect(screen.getByText("连接暂时中断")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: /刷\s*新/ }));
    await screen.findByText("测试文本任务");
    expect(screen.queryByText("任务读取失败")).toBeNull();
    expect(getUserGenerationTasks).toHaveBeenCalledTimes(2);
});

test("打开时明确显示正在读取，窗口重新聚焦会刷新当前任务页", async () => {
    let complete: (value: UserGenerationTaskPage) => void = () => undefined;
    vi.mocked(getUserGenerationTasks).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; })).mockResolvedValueOnce(page([task({ prompt: "已更新任务" })]));
    showCenter();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(within(screen.getByRole("status")).getByText("正在读取任务…")).toBeTruthy();
    await act(async () => complete(page([task()])));
    await screen.findByText("测试文本任务");
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText("已更新任务");
    await waitFor(() => expect(getUserGenerationTasks).toHaveBeenCalledTimes(2));
});

test("后台刷新及刷新失败保留当前列表，重试成功后更新内容", async () => {
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(getUserGenerationTasks).mockResolvedValueOnce(page([task()]))
        .mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }))
        .mockResolvedValueOnce(page([task({ prompt: "刷新后的任务" })]));
    showCenter();
    const originalRow = (await screen.findByText("测试文本任务")).closest("article");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /刷\s*新/ }));
    await waitFor(() => expect(getUserGenerationTasks).toHaveBeenCalledTimes(2));
    expect(screen.getByText("测试文本任务").closest("article")).toBe(originalRow);
    expect(screen.queryByText("正在读取任务…")).toBeNull();
    expect(screen.getByRole("group", { name: "进行中任务概况" }).textContent).toContain("排队中 1");
    await act(async () => fail(new Error("刷新连接中断")));
    await screen.findByText("任务刷新失败");
    expect(screen.getByText("刷新连接中断")).toBeTruthy();
    expect(screen.getByText("当前显示上次读取的任务，可重试更新。")).toBeTruthy();
    expect(screen.getByText("测试文本任务").closest("article")).toBe(originalRow);
    await user.click(screen.getByRole("button", { name: /重\s*试/ }));
    await screen.findByText("刷新后的任务");
    expect(screen.queryByText("任务刷新失败")).toBeNull();
});

test("进行中快捷筛选使用 active 并回到首页，切换筛选不会展示上一页任务", async () => {
    let complete: (value: UserGenerationTaskPage) => void = () => undefined;
    vi.mocked(getUserGenerationTasks).mockResolvedValueOnce({ ...page([task()]), total: 51 })
        .mockResolvedValueOnce({ ...page([task({ prompt: "第二页任务" })]), total: 51, offset: 50 })
        .mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }))
        .mockResolvedValueOnce(page([task({ prompt: "全部任务" })]));
    showCenter();
    await screen.findByText("测试文本任务");
    expect(getUserGenerationTasks).toHaveBeenNthCalledWith(1, { capability: "", status: "", offset: 0 }, expect.any(AbortSignal));
    const user = userEvent.setup();
    await user.click(screen.getByTitle("2"));
    await screen.findByText("第二页任务");
    await user.click(screen.getByRole("tab", { name: "进行中" }));
    await screen.findByText("正在读取任务…");
    expect(screen.queryByText("第二页任务")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "任务状态" })).toBeNull();
    expect(getUserGenerationTasks).toHaveBeenNthCalledWith(3, { capability: "", status: "active", offset: 0 }, expect.any(AbortSignal));
    await act(async () => complete(page([task({ prompt: "进行中的任务", status: "running" })])));
    await screen.findByText("进行中的任务");
    await user.click(screen.getByRole("tab", { name: "全部" }));
    await screen.findByText("全部任务");
    expect(screen.getByRole("combobox", { name: "任务状态" })).toBeTruthy();
    expect(getUserGenerationTasks).toHaveBeenNthCalledWith(4, { capability: "", status: "", offset: 0 }, expect.any(AbortSignal));
});

test("登录会话变化时不沿用上一会话的任务内容", async () => {
    let complete: (value: UserGenerationTaskPage) => void = () => undefined;
    vi.mocked(getUserGenerationTasks).mockResolvedValueOnce(page([task()]))
        .mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const view = showCenter();
    await screen.findByText("测试文本任务");
    currentSession.sessionVersion = 2;
    view.rerender();
    await screen.findByText("正在读取任务…");
    expect(screen.queryByText("测试文本任务")).toBeNull();
    await act(async () => complete(page([task({ prompt: "新会话任务" })])));
    await screen.findByText("新会话任务");
});

test("失败原因默认只显示首行，可展开和收起完整原文", async () => {
    const errorMessage = "请求未能完成\n上游返回的完整失败说明";
    vi.mocked(getUserGenerationTasks).mockResolvedValue(page([task({ status: "failed", errorMessage })]));
    showCenter();
    await screen.findByText("请求未能完成");
    expect(screen.queryByText(/上游返回的完整失败说明/)).toBeNull();
    const user = userEvent.setup();
    const expand = screen.getByRole("button", { name: "查看原因" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await user.click(expand);
    expect(screen.getByText(/上游返回的完整失败说明/).textContent).toBe(errorMessage);
    expect(screen.getByRole("button", { name: "收起原因" }).getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button", { name: "收起原因" }));
    expect(screen.queryByText(/上游返回的完整失败说明/)).toBeNull();
});

test("无活跃任务时简化概况，来源标题与提示词相同时只显示一次", async () => {
    vi.mocked(getUserGenerationTasks).mockResolvedValue({ ...page([task({ prompt: "同名对话", sourceTitle: "同名对话", status: "succeeded" })]), summary: { reviewing: 0, queued: 0, running: 0 } });
    showCenter();
    await screen.findByText("暂无进行中的任务");
    expect(screen.getAllByText("同名对话")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "查看对话" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "进行中任务概况" }).textContent).toBe("暂无进行中的任务");
    expect(screen.queryByText("切回窗口时更新，也可手动刷新任务状态。")).toBeNull();
});
