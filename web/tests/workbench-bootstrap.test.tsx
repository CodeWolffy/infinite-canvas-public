import { useRef, useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ session: 1, revision: 0, models: vi.fn(), history: vi.fn(), preferences: vi.fn(), apply: vi.fn(), select: vi.fn() }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: {} }) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ sessionVersion: api.session }) } }));
vi.mock("@/stores/use-workbench-agent-store", () => ({ useWorkbenchAgentStore: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: { getState: () => ({ hydratePlatformModels: async () => undefined }) } }));
vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: api.models }));
vi.mock("@/services/api/tasks", () => ({ getCapabilityBatches: api.history }));
vi.mock("@/services/api/generation", () => ({ getGenerationPreferences: api.preferences }));
import { useWorkbenchBootstrap, type GenerationBatchLog } from "@/hooks/use-generation-batches";
import type { PublicModel } from "@/services/api/generation";

function useBootstrap() {
    const modelsRef = useRef<PublicModel[]>([]);
    const preferencesRef = useRef({});
    const [logs, setLogs] = useState<GenerationBatchLog[]>([]);
    const [ids, setActiveBatchIds] = useState<string[]>([]);
    const bootstrap = useWorkbenchBootstrap({ capability: "image", modelsRef, preferencesRef,
        batches: { setLogs, setActiveBatchIds, applyDetail: () => ({ log: { id: "unused", status: "success", createdAt: 1 }, results: [] }), setPreviewLog: vi.fn(), setResults: vi.fn() },
        toLog: (batch) => ({ id: batch.id, status: "pending", createdAt: 1 }), applyPreferences: api.apply, resolveInitialBatchId: api.select,
        captureInputScope: () => { const revision = api.revision; const session = api.session; return () => { if (revision !== api.revision || session !== api.session) throw new DOMException("输入已改变", "AbortError"); }; },
    });
    return { ...bootstrap, logs, ids, setLogs, setActiveBatchIds, modelsRef };
}

beforeEach(() => {
    api.session = 1; api.revision = 0; vi.clearAllMocks();
    api.models.mockReset().mockResolvedValue([{ id: "image-model", capability: "image" }]);
    api.history.mockReset().mockResolvedValue({ batches: [] });
    api.preferences.mockReset().mockResolvedValue({ quality: "high" });
});
afterEach(cleanup);

test("历史与偏好失败不阻断模型就绪，局部重试仅重读失败资源", async () => {
    api.history.mockRejectedValueOnce(new Error("历史离线"));
    api.preferences.mockRejectedValueOnce(new Error("偏好离线"));
    const hook = renderHook(useBootstrap);
    await waitFor(() => expect(hook.result.current.initialized).toBe(true));
    expect(hook.result.current.modelsRef.current[0].id).toBe("image-model");
    expect(hook.result.current.historyError).toBe("历史离线");
    expect(hook.result.current.preferencesError).toBe("偏好离线");
    act(() => { hook.result.current.retryHistory(); hook.result.current.retryPreferences(); });
    await waitFor(() => expect(hook.result.current.historyReady).toBe(true));
    expect(hook.result.current.historyError).toBe("");
    expect(hook.result.current.preferencesError).toBe("");
    expect(api.models).toHaveBeenCalledTimes(1);
    expect(api.apply).toHaveBeenCalledWith({ quality: "high" }, [{ id: "image-model", capability: "image" }]);
});

test("迟到偏好和历史不能选择新输入的批次，历史合并保留期间新增任务", async () => {
    let history!: (value: unknown) => void;
    let preferences!: (value: unknown) => void;
    api.history.mockImplementation(() => new Promise((resolve) => { history = resolve; }));
    api.preferences.mockImplementation(() => new Promise((resolve) => { preferences = resolve; }));
    const hook = renderHook(useBootstrap);
    await waitFor(() => expect(hook.result.current.initialized).toBe(true));
    act(() => { api.revision++; hook.result.current.setLogs([{ id: "new", status: "pending", createdAt: 2 }]); hook.result.current.setActiveBatchIds(["new"]); });
    await act(async () => { history({ batches: [{ id: "old", summary: { activeCount: 1 } }] }); preferences({ quality: "low" }); });
    expect(hook.result.current.logs.map((log) => log.id)).toEqual(["new", "old"]);
    expect(hook.result.current.ids).toEqual(["new", "old"]);
    expect(api.apply).not.toHaveBeenCalled();
    expect(api.select).not.toHaveBeenCalled();
});

test("模型失败有独立重试，旧会话的迟到模型不能回填", async () => {
    api.models.mockRejectedValueOnce(new Error("模型离线"));
    const hook = renderHook(useBootstrap);
    await waitFor(() => expect(hook.result.current.modelsError).toBe("模型离线"));
    expect(hook.result.current.initialized).toBe(false);
    act(() => hook.result.current.retryModels());
    await waitFor(() => expect(hook.result.current.initialized).toBe(true));
    expect(api.history).toHaveBeenCalledTimes(1);
    let resolve!: (value: unknown) => void;
    api.models.mockImplementation(() => new Promise((done) => { resolve = done; }));
    act(() => hook.result.current.retryModels());
    api.session++;
    await act(async () => resolve([{ id: "old-account", capability: "image" }]));
    expect(hook.result.current.modelsRef.current[0].id).toBe("image-model");
});

test("已经编辑输入后重试偏好和历史仍不会回填默认值", async () => {
    api.history.mockRejectedValueOnce(new Error("历史离线"));
    api.preferences.mockRejectedValueOnce(new Error("偏好离线"));
    const hook = renderHook(useBootstrap);
    await waitFor(() => expect(hook.result.current.preferencesError).toBe("偏好离线"));
    api.revision++;
    act(() => { hook.result.current.retryHistory(); hook.result.current.retryPreferences(); });
    await waitFor(() => expect(hook.result.current.historyReady).toBe(true));
    expect(api.apply).not.toHaveBeenCalled();
    expect(api.select).not.toHaveBeenCalled();
});
