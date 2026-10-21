import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GenerationBatchDetail } from "@/services/api/generation";

const state = vi.hoisted(() => ({ sessionVersion: 1, listeners: new Set<(value: { sessionVersion: number }, previous: { sessionVersion: number }) => void>(), message: { success: vi.fn(), error: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: state.message }) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/use-workbench-agent-store", () => ({ useWorkbenchAgentStore: (selector: (value: unknown) => unknown) => selector({ updateTask: vi.fn() }) }));
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

class TestEventSource extends EventTarget {
    static all: TestEventSource[] = [];
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(public url: string) { super(); TestEventSource.all.push(this); }
    snapshot(detail: GenerationBatchDetail) { this.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(detail) })); }
}
const detail = (id: string, status = "running") => ({ batch: { id, prompt: "test", createdAt: "2026-01-01" }, tasks: [{ id: `${id}-task`, status }], referenceMediaIds: [] }) as unknown as GenerationBatchDetail;
const options = { toLog: (value: GenerationBatchDetail) => ({ log: { id: value.batch.id, createdAt: 1, status: value.tasks.some((task) => ["queued", "running", "reviewing"].includes(task.status)) ? "pending" as const : "success" as const }, results: [] }), notifyKeys: { success: "success", title: "title" } };

beforeEach(() => { state.sessionVersion = 1; TestEventSource.all = []; state.message.success.mockClear(); vi.stubGlobal("EventSource", TestEventSource); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
