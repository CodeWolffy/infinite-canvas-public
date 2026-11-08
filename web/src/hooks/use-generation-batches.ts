import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { deleteGenerationBatch, getGenerationPreferences, watchGenerationBatch, type GenerationBatchDetail, type GenerationBatchListItem, type GenerationTask, type PublicModel } from "@/services/api/generation";
import { fetchPublicModels } from "@/hooks/use-public-models";
import { getCapabilityBatches } from "@/services/api/tasks";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useUserStore } from "@/stores/use-user-store";
import { useConfigStore } from "@/stores/use-config-store";

export type GenerationBatchLog = { id: string; createdAt: number; status: "pending" | "success" | "failed" };

export function isActiveGenerationTask(task: GenerationTask) {
    return task.status === "reviewing" || task.status === "queued" || task.status === "running";
}

export function generationTaskDuration(task: GenerationTask) {
    const startedAt = task.startedAt || task.queuedAt;
    const finishedAt = task.finishedAt || (isActiveGenerationTask(task) ? new Date().toISOString() : startedAt);
    return Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

// 生图/视频工作台共享的生成批次轮询、记录合并、Agent 任务结算与完成通知逻辑。
export function useGenerationBatches<L extends GenerationBatchLog, R>(options: {
    toLog: (detail: GenerationBatchDetail) => { log: L; results: R[] };
    onDetail?: (detail: GenerationBatchDetail) => void;
    notifyKeys: { success: string; title: string };
}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const sessionVersion = useUserStore.getState().sessionVersion;
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const [logs, setLogs] = useState<L[]>([]);
    const [activeBatchIds, setActiveBatchIds] = useState<string[]>([]);
    const [subscriptionErrors, setSubscriptionErrors] = useState<Record<string, string>>({});
    const mountedRef = useRef(false);
    const activeBatchIdsRef = useRef<string[]>([]);
    const previewLogIdRef = useRef("");
    const watchedBatchesRef = useRef(new Set<string>());
    const subscriptionsRef = useRef(new Map<string, { cleanup: () => void }>());
    const agentTasksRef = useRef(new Map<string, Set<string>>());
    const defaultTitleRef = useRef(document.title);
    const applyDetailRef = useRef<(detail: GenerationBatchDetail) => { log: L; results: R[] }>(() => { throw new Error("uninitialized"); });
    const [previewLog, setPreviewLog] = useState<L | null>(null);
    const [results, setResults] = useState<R[]>([]);

    useEffect(() => {
        mountedRef.current = true;
        const subscriptions = subscriptionsRef.current;
        const clearSubscriptions = () => {
            const stale = [...subscriptions.values()];
            subscriptions.clear();
            stale.forEach(({ cleanup }) => cleanup());
        };
        const unsubscribe = useUserStore.subscribe((state, previous) => {
            if (state.sessionVersion === previous.sessionVersion) return;
            clearSubscriptions();
            watchedBatchesRef.current.clear();
            agentTasksRef.current.clear();
            activeBatchIdsRef.current = [];
            previewLogIdRef.current = "";
            setActiveBatchIds([]);
            setSubscriptionErrors({});
            setLogs([]);
            setPreviewLog(null);
            setResults([]);
        });
        return () => { mountedRef.current = false; unsubscribe(); clearSubscriptions(); };
    }, []);

    useEffect(() => {
        activeBatchIdsRef.current = activeBatchIds;
    }, [activeBatchIds]);

    useEffect(() => {
        const syncTitle = () => {
            const count = activeBatchIdsRef.current.filter((id) => !subscriptionErrors[id]).length;
            document.title = count ? t("imageWorkbench.runningTabTitle", { count }) : defaultTitleRef.current;
        };
        if (!document.hidden) syncTitle();
        document.addEventListener("visibilitychange", syncTitle);
        return () => document.removeEventListener("visibilitychange", syncTitle);
    }, [activeBatchIds.length, subscriptionErrors, t]);

    useEffect(() => {
        previewLogIdRef.current = previewLog?.id ?? "";
    }, [previewLog]);

    // 活跃批次走 SSE 推送：任务状态变化时服务端立刻下发快照，任务全部结束后服务端关闭连接；
    // 连接异常时 watchGenerationBatch 内部会退化为轮询兜底；终止错误保留任务状态，等待手动恢复监听。
    useEffect(() => {
        if (sessionVersion !== useUserStore.getState().sessionVersion) return;
        const subscriptions = subscriptionsRef.current;
        const active = new Set(activeBatchIds);
        subscriptions.forEach((subscription, id) => {
            if (!active.has(id)) { subscriptions.delete(id); subscription.cleanup(); }
        });
        active.forEach((batchId) => {
            if (subscriptions.has(batchId) || subscriptionErrors[batchId]) return;
            const subscription = { cleanup: () => {} };
            const isCurrent = () => mountedRef.current && sessionVersion === useUserStore.getState().sessionVersion && subscriptions.get(batchId) === subscription;
            const onError = (error: Error) => {
                if (!isCurrent()) return;
                subscriptions.delete(batchId);
                subscription.cleanup();
                setSubscriptionErrors((current) => ({ ...current, [batchId]: error.message || "生成状态读取中断，请恢复状态同步" }));
            };
            subscriptions.set(batchId, subscription);
            try {
                subscription.cleanup = watchGenerationBatch(batchId, (detail) => {
                    if (!isCurrent()) return;
                    const applied = applyDetailRef.current(detail);
                    if (previewLogIdRef.current === batchId) {
                        setPreviewLog(applied.log);
                        setResults(applied.results);
                    }
                }, undefined, onError);
                if (!isCurrent()) subscription.cleanup();
            } catch (error) {
                onError(error instanceof Error ? error : new Error("生成状态读取中断，请恢复状态同步"));
            }
        });
    }, [activeBatchIds, sessionVersion, subscriptionErrors]);

    const ensureNotifyPermission = () => {
        if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    };

    const notifyCompletion = (detail: GenerationBatchDetail) => {
        const successCount = detail.tasks.filter((task) => task.status === "succeeded").length;
        if (successCount) message.success(t(options.notifyKeys.success));
        else message.error(detail.tasks.find((task) => task.errorMessage)?.errorMessage || t("workbench.generationFailed"));
        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
            document.title = t("imageWorkbench.completedTabTitle");
            const notification = new Notification(t(options.notifyKeys.title), { body: detail.batch.prompt.slice(0, 80), icon: "/logo.svg" });
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
        }
    };

    const settleAgentTask = (batchId: string, detail: GenerationBatchDetail) => {
        const agentTaskIds = agentTasksRef.current.get(batchId);
        if (!agentTaskIds) return;
        agentTasksRef.current.delete(batchId);
        const successCount = detail.tasks.filter((task) => task.status === "succeeded").length;
        agentTaskIds.forEach((id) => updateAgentTask(id, { status: successCount ? "succeeded" : "failed", successCount, failCount: detail.tasks.filter((task) => task.status === "failed" || task.status === "canceled").length, error: successCount ? undefined : detail.tasks.find((task) => task.errorMessage)?.errorMessage ?? undefined }));
    };

    const applyDetail = (detail: GenerationBatchDetail) => {
        const applied = options.toLog(detail);
        options.onDetail?.(detail);
        setLogs((current) => [applied.log, ...current.filter((item) => item.id !== applied.log.id)].sort((a, b) => b.createdAt - a.createdAt));
        const active = applied.log.status === "pending";
        setActiveBatchIds((current) => {
            if (current.includes(applied.log.id) === active) return current;
            return active ? [...current, applied.log.id] : current.filter((id) => id !== applied.log.id);
        });
        if (active) watchedBatchesRef.current.add(applied.log.id);
        else {
            setSubscriptionErrors((current) => {
                if (!(applied.log.id in current)) return current;
                const next = { ...current };
                delete next[applied.log.id];
                return next;
            });
            if (watchedBatchesRef.current.delete(applied.log.id)) {
                settleAgentTask(applied.log.id, detail);
                notifyCompletion(detail);
            }
        }
        return applied;
    };

    applyDetailRef.current = applyDetail;

    const watchBatch = (batchId: string) => {
        if (!mountedRef.current || sessionVersion !== useUserStore.getState().sessionVersion) return;
        watchedBatchesRef.current.add(batchId);
        setSubscriptionErrors((current) => {
            if (!(batchId in current)) return current;
            const next = { ...current };
            delete next[batchId];
            return next;
        });
        setActiveBatchIds((current) => (current.includes(batchId) ? current : [...current, batchId]));
    };

    const registerAgentTask = (batchId: string, agentTaskId: string) => {
        const tasks = agentTasksRef.current.get(batchId) || new Set<string>();
        tasks.add(agentTaskId);
        agentTasksRef.current.set(batchId, tasks);
        watchedBatchesRef.current.add(batchId);
    };

    const deleteBatches = async (ids: string[]) => {
        if (!mountedRef.current || sessionVersion !== useUserStore.getState().sessionVersion) return [];
        const settled = await Promise.allSettled(ids.map((id) => deleteGenerationBatch(id)));
        if (!mountedRef.current || sessionVersion !== useUserStore.getState().sessionVersion) return [];
        const deletedIds = ids.flatMap((id, index) => (settled[index]?.status === "fulfilled" ? [id] : []));
        if (deletedIds.length) {
            const deleted = new Set(deletedIds);
            setLogs((current) => current.filter((log) => !deleted.has(log.id)));
            message.success(`已删除 ${deletedIds.length} 条生成记录`);
        }
        const failure = settled.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") message.error(failure.reason instanceof Error ? failure.reason.message : "部分记录删除失败");
        return deletedIds;
    };

    return { logs, setLogs, activeBatchIds, setActiveBatchIds, activeBatchIdsRef, subscriptionErrors, retrySubscription: watchBatch, previewLog, setPreviewLog, previewLogIdRef, watchedBatchesRef, results, setResults, applyDetail, watchBatch, registerAgentTask, deleteBatches, ensureNotifyPermission };
}

// 模型、历史和偏好独立加载；模型就绪即可创作，历史或偏好失败只影响对应区域。
export function useWorkbenchBootstrap<L extends GenerationBatchLog, R>(options: {
    capability: "image" | "video";
    modelsRef: { current: PublicModel[] };
    preferencesRef: { current: Record<string, unknown> };
    batches: {
        setLogs: Dispatch<SetStateAction<L[]>>;
        setActiveBatchIds: Dispatch<SetStateAction<string[]>>;
        applyDetail: (detail: GenerationBatchDetail) => { log: L; results: R[] };
        setPreviewLog: (log: L) => void;
        setResults: (results: R[]) => void;
    };
    toLog: (batch: GenerationBatchListItem, models: PublicModel[]) => L;
    applyPreferences: (preferences: Record<string, unknown>, models: PublicModel[]) => void;
    resolveInitialBatchId: (batches: GenerationBatchListItem[]) => string | null | undefined;
    onBatch?: (batch: GenerationBatchListItem) => void;
    captureInputScope: () => () => void;
}) {
    const session = useUserStore.getState().sessionVersion;
    const current = useRef(options);
    current.current = options;
    const initialInputScope = useRef<() => void>(() => {});
    const [modelsSession, setModelsSession] = useState<number | null>(null);
    const [historySession, setHistorySession] = useState<number | null>(null);
    const initialized = modelsSession === session;
    const historyReady = historySession === session;
    const [modelsError, setModelsError] = useState("");
    const [historyError, setHistoryError] = useState("");
    const [preferencesError, setPreferencesError] = useState("");
    const [attempts, setAttempts] = useState({ models: 0, history: 0, preferences: 0 });
    const [preferences, setPreferences] = useState<{ value: Record<string, unknown>; assertInput: () => void } | null>(null);

    useEffect(() => { initialInputScope.current = current.current.captureInputScope(); }, [session]);

    useEffect(() => {
        let disposed = false;
        setModelsError("");
        void Promise.all([fetchPublicModels(), useConfigStore.getState().hydratePlatformModels()]).then(([available]) => {
            if (disposed || useUserStore.getState().sessionVersion !== session) return;
            current.current.modelsRef.current = available.filter((item) => item.capability === current.current.capability);
            setModelsSession(session);
        }).catch((error) => {
            if (!disposed && useUserStore.getState().sessionVersion === session) setModelsError(error instanceof Error ? error.message : "模型加载失败");
        });
        return () => { disposed = true; };
    }, [session, attempts.models]);

    useEffect(() => {
        let disposed = false;
        const assertInput = initialInputScope.current;
        setHistoryError("");
        void getCapabilityBatches(current.current.capability).then(({ batches }) => {
            if (disposed || useUserStore.getState().sessionVersion !== session) return;
            const options = current.current;
            batches.forEach((batch) => options.onBatch?.(batch));
            options.batches.setLogs((logs) => [...logs, ...batches.filter((batch) => !logs.some((log) => log.id === batch.id)).map((batch) => options.toLog(batch, options.modelsRef.current))].sort((a, b) => b.createdAt - a.createdAt));
            options.batches.setActiveBatchIds((ids) => [...new Set([...ids, ...batches.filter((batch) => batch.summary.activeCount > 0).map((batch) => batch.id)])]);
            setHistorySession(session);
            try { assertInput(); } catch { return; }
            options.resolveInitialBatchId(batches);
        }).catch((error) => {
            if (!disposed && useUserStore.getState().sessionVersion === session) setHistoryError(error instanceof Error ? error.message : "生成记录加载失败");
        });
        return () => { disposed = true; };
    }, [session, attempts.history]);

    useEffect(() => {
        let disposed = false;
        const assertInput = initialInputScope.current;
        setPreferencesError("");
        void getGenerationPreferences().then((value) => {
            if (disposed || useUserStore.getState().sessionVersion !== session) return;
            current.current.preferencesRef.current = value;
            setPreferences({ value, assertInput });
        }).catch((error) => {
            if (!disposed && useUserStore.getState().sessionVersion === session) setPreferencesError(error instanceof Error ? error.message : "偏好加载失败");
        });
        return () => { disposed = true; };
    }, [session, attempts.preferences]);

    useEffect(() => {
        if (!initialized || !preferences) return;
        try { preferences.assertInput(); } catch { return; }
        current.current.applyPreferences(preferences.value, current.current.modelsRef.current);
    }, [initialized, preferences]);

    return { initialized, historyReady, modelsError, historyError, preferencesError,
        retryModels: () => setAttempts((value) => ({ ...value, models: value.models + 1 })),
        retryHistory: () => setAttempts((value) => ({ ...value, history: value.history + 1 })),
        retryPreferences: () => setAttempts((value) => ({ ...value, preferences: value.preferences + 1 })),
    };
}
