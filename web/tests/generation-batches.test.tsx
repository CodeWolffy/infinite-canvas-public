import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GenerationBatchDetail } from "@/services/api/generation";

const state = vi.hoisted(() => ({ sessionVersion: 1, listeners: new Set<(value: { sessionVersion: number }, previous: { sessionVersion: number }) => void>(), updateTask: vi.fn(), message: { success: vi.fn(), error: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: state.message }) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/use-workbench-agent-store", () => ({ useWorkbenchAgentStore: (selector: (value: unknown) => unknown) => selector({ updateTask: state.updateTask }) }));
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: { getState: () => ({}) } }));
vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/services/api/tasks", () => ({ getCapabilityBatches: vi.fn() }));
vi.mock("@/services/api/request", () => ({ apiRequest: vi.fn(), ApiError: class extends Error {} }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => state, subscribe: (listener: (value: { sessionVersion: number }, previous: { sessionVersion: number }) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } },
    assertCurrentSession: (version: number) => { if (state.sessionVersion !== version) throw new DOMException("会话已变化", "AbortError"); },
}));

import { useGenerationBatches } from "@/hooks/use-generation-batches";
import { apiRequest } from "@/services/api/request";
import * as generationApi from "@/services/api/generation";

class TestEventSource extends EventTarget {
    static all: TestEventSource[] = [];
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(public url: string) { super(); TestEventSource.all.push(this); }
    snapshot(detail: GenerationBatchDetail) { this.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(detail) })); }
}
const detail = (id: string, status = "running") => ({ batch: { id, prompt: "test", createdAt: "2026-01-01" }, tasks: [{ id: `${id}-task`, status }], referenceMediaIds: [], referenceMedia: [] }) as unknown as GenerationBatchDetail;
const options = { toLog: (value: GenerationBatchDetail) => ({ log: { id: value.batch.id, createdAt: 1, status: value.tasks.some((task) => ["queued", "running", "reviewing"].includes(task.status)) ? "pending" as const : "success" as const }, results: [] }), notifyKeys: { success: "success", title: "title" } };

beforeEach(() => { state.sessionVersion = 1; TestEventSource.all = []; vi.clearAllMocks(); vi.stubGlobal("EventSource", TestEventSource); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test("重复初始快照不重连，其它批次增删也不打断已有 SSE", () => {
    const hook = renderHook(() => useGenerationBatches(options));
    act(() => hook.result.current.watchBatch("a"));
    const first = TestEventSource.all[0];
    for (let index = 0; index < 8; index++) act(() => first.snapshot(detail("a")));
    expect(TestEventSource.all).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
    act(() => hook.result.current.watchBatch("b"));
    expect(TestEventSource.all).toHaveLength(2);
    act(() => TestEventSource.all[1].snapshot(detail("b", "succeeded")));
    expect(first.close).not.toHaveBeenCalled();
    expect(state.message.success).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(first.close).toHaveBeenCalledTimes(1);
});

test("断线后轮询恢复 SSE，换会话立即停止订阅", async () => {
    vi.useFakeTimers();
    vi.mocked(apiRequest).mockResolvedValue(detail("a"));
    const hook = renderHook(() => useGenerationBatches(options));
    act(() => hook.result.current.watchBatch("a"));
    await act(async () => { TestEventSource.all[0].onerror?.(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(TestEventSource.all).toHaveLength(2);
    act(() => { const previous = { sessionVersion: state.sessionVersion }; state.sessionVersion++; state.listeners.forEach((listener) => listener(state, previous)); });
    expect(TestEventSource.all[1].close).toHaveBeenCalledTimes(1);
});

test("终止错误保留任务状态并停止自动监听，手动恢复原批次后才结算 Agent", () => {
    document.title = "生成工作台";
    const hook = renderHook(() => useGenerationBatches(options));
    act(() => { hook.result.current.registerAgentTask("a", "agent-a"); hook.result.current.watchBatch("a"); });
    act(() => TestEventSource.all[0].snapshot(detail("a")));
    act(() => TestEventSource.all[0].dispatchEvent(new Event("unavailable")));
    expect(hook.result.current.subscriptionErrors.a).toContain("生成批次");
    expect(hook.result.current.activeBatchIds).toEqual(["a"]);
    expect(hook.result.current.logs[0].status).toBe("pending");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("生成工作台");
    expect(state.updateTask).not.toHaveBeenCalled();
    expect(state.message.error).not.toHaveBeenCalled();
    act(() => hook.result.current.watchBatch("b"));
    act(() => TestEventSource.all[1].snapshot(detail("b", "succeeded")));
    expect(TestEventSource.all).toHaveLength(2);
    act(() => { hook.result.current.retrySubscription("a"); hook.result.current.retrySubscription("a"); });
    expect(hook.result.current.subscriptionErrors).toEqual({});
    expect(TestEventSource.all).toHaveLength(3);
    expect(TestEventSource.all[2].url).toBe("/api/generation-batches/a/events");
    act(() => TestEventSource.all[2].snapshot(detail("a", "succeeded")));
    expect(hook.result.current.activeBatchIds).toEqual([]);
    expect(state.updateTask).toHaveBeenCalledExactlyOnceWith("agent-a", expect.objectContaining({ status: "succeeded", successCount: 1 }));
});

function captureSubscriptions() {
    const subscriptions: { snapshot: (value: GenerationBatchDetail) => void; fail: (error: Error) => void; cleanup: ReturnType<typeof vi.fn> }[] = [];
    vi.spyOn(generationApi, "watchGenerationBatch").mockImplementation((_id, snapshot, _signal, onError) => {
        const subscription = { snapshot, fail: onError!, cleanup: vi.fn() };
        subscriptions.push(subscription);
        return subscription.cleanup;
    });
    return subscriptions;
}

test("恢复后旧订阅的迟到快照和错误不能覆盖新订阅，切换预览也不会串批次", () => {
    const subscriptions = captureSubscriptions();
    const onDetail = vi.fn();
    const hook = renderHook(() => useGenerationBatches({ ...options, onDetail }));
    act(() => hook.result.current.watchBatch("a"));
    act(() => subscriptions[0].fail(new Error("读取中断")));
    expect(subscriptions[0].cleanup).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.retrySubscription("a"));
    act(() => { subscriptions[0].snapshot(detail("a", "succeeded")); subscriptions[0].fail(new Error("旧错误")); });
    expect(hook.result.current.subscriptionErrors).toEqual({});
    expect(hook.result.current.logs).toEqual([]);
    expect(onDetail).not.toHaveBeenCalled();
    act(() => hook.result.current.setPreviewLog({ id: "b", createdAt: 1, status: "pending" }));
    act(() => subscriptions[1].snapshot(detail("a")));
    expect(hook.result.current.logs[0].id).toBe("a");
    expect(hook.result.current.previewLog?.id).toBe("b");
    expect(onDetail).toHaveBeenCalledTimes(1);
});

test.each(["unmount", "session"])("%s 后的迟到订阅回调和旧恢复动作均不写状态或结算 Agent", (mode) => {
    const subscriptions = captureSubscriptions();
    const onDetail = vi.fn();
    const hook = renderHook(() => useGenerationBatches({ ...options, onDetail }));
    act(() => { hook.result.current.registerAgentTask("a", "agent-a"); hook.result.current.watchBatch("a"); });
    const retry = hook.result.current.retrySubscription;
    if (mode === "unmount") hook.unmount();
    else act(() => { const previous = { sessionVersion: state.sessionVersion }; state.sessionVersion++; state.listeners.forEach((listener) => listener(state, previous)); });
    act(() => { subscriptions[0].snapshot(detail("a", "succeeded")); subscriptions[0].fail(new Error("迟到错误")); retry("a"); });
    expect(subscriptions[0].cleanup).toHaveBeenCalledTimes(1);
    expect(subscriptions).toHaveLength(1);
    expect(onDetail).not.toHaveBeenCalled();
    expect(state.updateTask).not.toHaveBeenCalled();
    expect(state.message.success).not.toHaveBeenCalled();
    expect(state.message.error).not.toHaveBeenCalled();
    if (mode === "session") {
        expect(hook.result.current.activeBatchIds).toEqual([]);
        expect(hook.result.current.subscriptionErrors).toEqual({});
        act(() => hook.result.current.watchBatch("a"));
        act(() => subscriptions[1].snapshot(detail("a", "succeeded")));
        expect(state.updateTask).not.toHaveBeenCalled();
    }
});

test("订阅启动时同步终止也能释放订阅并再次手动恢复", () => {
    const firstCleanup = vi.fn();
    vi.spyOn(generationApi, "watchGenerationBatch").mockImplementationOnce((_id, _snapshot, _signal, onError) => {
        onError?.(new Error("连接启动失败"));
        return firstCleanup;
    });
    const hook = renderHook(() => useGenerationBatches(options));
    act(() => hook.result.current.watchBatch("a"));
    expect(hook.result.current.subscriptionErrors.a).toBe("连接启动失败");
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.retrySubscription("a"));
    expect(TestEventSource.all).toHaveLength(1);
    expect(hook.result.current.subscriptionErrors).toEqual({});
});

test("幂等恢复直接返回终态时，立即结算同批次关联的 Agent 任务", () => {
    const hook = renderHook(() => useGenerationBatches(options));
    act(() => {
        hook.result.current.registerAgentTask("a", "agent-original");
        hook.result.current.registerAgentTask("a", "agent-retry");
        hook.result.current.applyDetail(detail("a", "succeeded"));
    });
    expect(state.updateTask).toHaveBeenCalledWith("agent-original", expect.objectContaining({ status: "succeeded", successCount: 1 }));
    expect(state.updateTask).toHaveBeenCalledWith("agent-retry", expect.objectContaining({ status: "succeeded", successCount: 1 }));
    expect(state.updateTask).toHaveBeenCalledTimes(2);
    expect(TestEventSource.all).toHaveLength(0);
    act(() => hook.result.current.applyDetail(detail("a", "succeeded")));
    expect(state.updateTask).toHaveBeenCalledTimes(2);
});
