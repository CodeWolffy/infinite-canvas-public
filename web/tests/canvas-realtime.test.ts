import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watchCanvas } from "@/services/api/canvas-realtime";
import { ApiError } from "@/services/api/request";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";

const mocks = vi.hoisted(() => ({
    state: { sessionVersion: 1 }, subscribers: new Set<(state: { sessionVersion: number }) => void>(), request: vi.fn(),
}));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: {
    getState: () => mocks.state,
    subscribe: (listener: (state: typeof mocks.state) => void) => { mocks.subscribers.add(listener); return () => mocks.subscribers.delete(listener); },
} }));
vi.mock("@/services/api/request", () => ({ apiRequest: mocks.request, ApiError: class extends Error {
    constructor(message: string, public status: number) { super(message); }
} }));

class Source extends EventTarget {
    static instances: Source[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(public url: string, public options: EventSourceInit) { super(); Source.instances.push(this); }
    emit(name: string, value?: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(value) })); }
}
function deferred() {
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((_, fail) => { reject = fail; });
    return { promise, reject };
}
const project = (id = "canvas-a"): CanvasProjectDetail => ({ id, title: "协作画布", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", nodeCount: 0, connectionCount: 0, snapshot: { nodes: [], connections: [] } });
const member = { userId: "member", username: "bob", displayName: "协作者" };
const callbacks = () => ({ snapshot: vi.fn(), presence: vi.fn(), status: vi.fn(), unavailable: vi.fn() });
function switchSession() { mocks.state.sessionVersion++; for (const listener of [...mocks.subscribers]) listener(mocks.state); }

beforeEach(() => {
    vi.useFakeTimers();
    mocks.state.sessionVersion = 1;
    mocks.subscribers.clear();
    mocks.request.mockReset().mockResolvedValue(undefined);
    Source.instances = [];
    vi.stubGlobal("EventSource", Source);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test("只接收当前画布的快照和在线成员，连接携带登录凭据", () => {
    const handlers = callbacks(), stop = watchCanvas("canvas-a", handlers), source = Source.instances[0];
    expect(source.url).toBe("/api/canvas-projects/canvas-a/events");
    expect(source.options).toEqual({ withCredentials: true });
    source.emit("snapshot", { project: project("another-canvas") });
    expect(handlers.snapshot).not.toHaveBeenCalled();
    source.emit("snapshot", { project: project() });
    source.emit("presence", { members: [member] });
    expect(handlers.snapshot).toHaveBeenCalledExactlyOnceWith(project());
    expect(handlers.presence).toHaveBeenCalledExactlyOnceWith([member]);
    expect(handlers.status).toHaveBeenLastCalledWith("online");
    stop();
});

test("打开连接立即上报在线，之后每30秒心跳，停止后只清理一次且不再请求", async () => {
    const handlers = callbacks(), stop = watchCanvas("canvas-a", handlers), source = Source.instances[0];
    expect(mocks.request).not.toHaveBeenCalled();
    source.onopen?.();
    expect(mocks.request).toHaveBeenCalledOnce();
    const [, options] = mocks.request.mock.calls[0];
    expect(mocks.request.mock.calls[0][0]).toBe("/api/canvas-projects/canvas-a/presence");
    expect(options.method).toBe("POST");
    expect(options.body.clientId).toEqual(expect.any(String));
    expect(options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(29999);
    expect(mocks.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1][1].body.clientId).toBe(options.body.clientId);
    stop();
    stop();
    expect(source.close).toHaveBeenCalledOnce();
    expect(options.signal.aborted).toBe(true);
    expect(mocks.subscribers.size).toBe(0);
    expect(mocks.request).toHaveBeenLastCalledWith(`/api/canvas-projects/canvas-a/presence/${options.body.clientId}`, { method: "DELETE", keepalive: true });
    await vi.advanceTimersByTimeAsync(90000);
    source.onopen?.();
    expect(mocks.request).toHaveBeenCalledTimes(3);
});

test("退出或更换账号立即关闭连接，旧事件和心跳失败不写入新会话", async () => {
    const pending = deferred();
    mocks.request.mockReturnValue(pending.promise);
    const handlers = callbacks(), stop = watchCanvas("canvas-a", handlers), source = Source.instances[0];
    source.onopen?.();
    const signal = mocks.request.mock.calls[0][1].signal as AbortSignal;
    switchSession();
    expect(source.close).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    expect(mocks.subscribers.size).toBe(0);
    source.emit("snapshot", { project: project() });
    source.emit("presence", { members: [member] });
    source.emit("unavailable");
    source.emit("expired");
    source.onerror?.();
    source.onopen?.();
    pending.reject(new ApiError("旧账号无权", 403));
    await vi.advanceTimersByTimeAsync(90000);
    expect(handlers.snapshot).not.toHaveBeenCalled();
    expect(handlers.presence).not.toHaveBeenCalled();
    expect(handlers.status).not.toHaveBeenCalled();
    expect(handlers.unavailable).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledOnce();
    stop();
    expect(mocks.request).toHaveBeenCalledOnce();
});

test.each(["expired", "unavailable"])("服务端%s终止同步，重复事件与迟到快照不再回调", async (event) => {
    const handlers = callbacks(), stop = watchCanvas("canvas-a", handlers), source = Source.instances[0];
    source.emit(event);
    expect(handlers.status).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(handlers.unavailable).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls[0][1]).toEqual({ method: "DELETE", keepalive: true });
    source.emit(event);
    source.emit("snapshot", { project: project() });
    source.emit("presence", { members: [member] });
    await vi.advanceTimersByTimeAsync(60000);
    expect(handlers.snapshot).not.toHaveBeenCalled();
    expect(handlers.presence).not.toHaveBeenCalled();
    expect(handlers.unavailable).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledOnce();
    stop();
});

test.each([401, 403, 404])("心跳返回%d停止同步并通知权限不可用", async (status) => {
    mocks.request.mockRejectedValueOnce(new ApiError("访问不可用", status));
    const handlers = callbacks(), stop = watchCanvas("canvas-a", handlers), source = Source.instances[0];
    source.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers.status).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(handlers.unavailable).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    stop();
});

test("短暂网络失败保留连接，后续心跳与快照恢复在线状态", async () => {
    mocks.request.mockRejectedValueOnce(new Error("network offline"));
    const handlers = callbacks(), stop = watchCanvas("canvas-a", handlers), source = Source.instances[0];
    source.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers.status).toHaveBeenLastCalledWith("reconnecting");
    expect(handlers.unavailable).not.toHaveBeenCalled();
    expect(source.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    source.emit("snapshot", { project: project() });
    expect(handlers.status).toHaveBeenLastCalledWith("online");
    stop();
});

test("损坏的SSE消息不回填画布，连接错误只标记重连", () => {
    const handlers = callbacks(), stop = watchCanvas("canvas-a", handlers), source = Source.instances[0];
    source.dispatchEvent(new MessageEvent("snapshot", { data: "not json" }));
    source.dispatchEvent(new MessageEvent("presence", { data: "not json" }));
    source.onerror?.();
    expect(handlers.snapshot).not.toHaveBeenCalled();
    expect(handlers.presence).not.toHaveBeenCalled();
    expect(handlers.status.mock.calls).toEqual([["reconnecting"], ["reconnecting"], ["reconnecting"]]);
    expect(source.close).not.toHaveBeenCalled();
    stop();
});
