import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@/services/api/generation", () => ({ GENERATION_PAGE_SIZE: 50 }));
vi.mock("@/stores/use-user-store", () => ({ assertCurrentSession: vi.fn(), useUserStore: { getState: () => ({ sessionVersion: 1 }) } }));
vi.mock("@/services/api/request", async (importOriginal) => ({ ...await importOriginal<typeof import("@/services/api/request")>(), apiRequest: vi.fn() }));

import { apiRequest } from "@/services/api/request";
import { getUserGenerationTasks, getUserTaskSourcePath, type UserGenerationTask } from "@/services/api/user-tasks";

const task = (fields: Partial<UserGenerationTask> = {}) => ({ id: "task", capability: "image", batchId: "batch", conversationId: null, canvasProjectId: null, sourceUnavailable: null, ...fields }) as UserGenerationTask;

beforeEach(() => vi.mocked(apiRequest).mockReset());

test("任务列表沿用生成分页大小，并把筛选、偏移和取消信号交给统一请求入口", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ tasks: [], total: 0, limit: 50, offset: 0, summary: { reviewing: 0, queued: 0, running: 0 } });
    await getUserGenerationTasks();
    const initial = new URL(vi.mocked(apiRequest).mock.calls[0][0], "http://localhost");
    expect(initial.pathname).toBe("/api/generation-tasks");
    expect(initial.searchParams.get("limit")).toBe("50");
    expect(initial.searchParams.get("offset")).toBe("0");
    const controller = new AbortController();
    await getUserGenerationTasks({ capability: "text", status: "reviewing", offset: 50 }, controller.signal);
    const filtered = new URL(vi.mocked(apiRequest).mock.calls[1][0], "http://localhost");
    expect(filtered.searchParams.get("capability")).toBe("text");
    expect(filtered.searchParams.get("status")).toBe("reviewing");
    expect(filtered.searchParams.get("offset")).toBe("50");
    expect(vi.mocked(apiRequest).mock.calls[1][1]?.signal).toBe(controller.signal);
});

test("画布优先返回项目，文本使用会话参数，图片与视频使用批次参数", () => {
    expect(getUserTaskSourcePath(task({ canvasProjectId: "canvas" }))).toBe("/canvas/canvas");
    expect(getUserTaskSourcePath(task({ capability: "text", batchId: null, conversationId: "conversation" }))).toBe("/text?conversation=conversation");
    expect(getUserTaskSourcePath(task({ capability: "text", canvasProjectId: "canvas", conversationId: "conversation" }))).toBe("/canvas/canvas");
    expect(getUserTaskSourcePath(task())).toBe("/image?batch=batch");
    expect(getUserTaskSourcePath(task({ capability: "video" }))).toBe("/video?batch=batch");
});

test("音频及无来源任务不会生成不存在的页面，已撤权来源不能通过保留ID跳转", () => {
    expect(getUserTaskSourcePath(task({ capability: "audio", batchId: null }))).toBeNull();
    expect(getUserTaskSourcePath(task({ capability: "audio" }))).toBeNull();
    expect(getUserTaskSourcePath(task({ batchId: null }))).toBeNull();
    expect(getUserTaskSourcePath(task({ capability: "text", conversationId: null }))).toBeNull();
    expect(getUserTaskSourcePath(task({ canvasProjectId: "revoked", sourceUnavailable: "canvas" }))).toBeNull();
    expect(getUserTaskSourcePath(task({ capability: "text", conversationId: "deleted", sourceUnavailable: "conversation" }))).toBeNull();
});
