import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/services/api/generation", () => ({ GENERATION_PAGE_SIZE: 50 }));
vi.mock("@/stores/use-user-store", () => {
    const current = { sessionVersion: 1, user: { id: "self" } };
    return { assertCurrentSession: vi.fn(), useUserStore: Object.assign((selector: (state: typeof current) => unknown) => selector(current), { getState: () => current }) };
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
    render(<MemoryRouter><QueryClientProvider client={client}><GenerationTaskCenter onClose={vi.fn()} /></QueryClientProvider></MemoryRouter>);
}

beforeAll(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
beforeEach(() => vi.mocked(getUserGenerationTasks).mockReset());
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); });

test("任务中心展示服务端概况、音频预览，并隐藏失效画布的提示词与媒体", async () => {
    vi.mocked(getUserGenerationTasks).mockResolvedValue(page([
        task(),
        task({ id: "audio", capability: "audio", conversationId: null, sourceTitle: null, prompt: "测试音频任务", status: "succeeded", output: { mediaId: "audio-result", url: "/api/media/audio-result", mimeType: "audio/mpeg", bytes: 1 } }),
        task({ id: "revoked", capability: "image", conversationId: null, canvasProjectId: "revoked-canvas", sourceUnavailable: "canvas", prompt: "不能显示的提示词", errorMessage: "不能显示的私有错误", output: { mediaId: "hidden", url: "/api/media/hidden", mimeType: "image/png", bytes: 1 } }),
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
    expect(screen.queryByAltText("生成结果")).toBeNull();
    expect(screen.getAllByRole("button", { name: "回到来源" })).toHaveLength(1);
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
