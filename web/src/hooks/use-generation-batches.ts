import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { deleteGenerationBatch, getGenerationBatch, watchGenerationBatch, type GenerationBatchDetail, type GenerationBatchListItem, type GenerationTask, type PublicModel } from "@/services/api/generation";
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
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const [logs, setLogs] = useState<L[]>([]);
    const [activeBatchIds, setActiveBatchIds] = useState<string[]>([]);
    const activeBatchIdsRef = useRef<string[]>([]);
    const previewLogIdRef = useRef("");
    const watchedBatchesRef = useRef(new Set<string>());
    const agentTasksRef = useRef(new Map<string, string>());
    const defaultTitleRef = useRef(document.title);
    const applyDetailRef = useRef<(detail: GenerationBatchDetail) => { log: L; results: R[] }>(() => { throw new Error("uninitialized"); });
    const [previewLog, setPreviewLog] = useState<L | null>(null);
    const [results, setResults] = useState<R[]>([]);

    useEffect(() => {
        activeBatchIdsRef.current = activeBatchIds;
    }, [activeBatchIds]);

    useEffect(() => {
        const syncTitle = () => {
            const count = activeBatchIdsRef.current.length;
            document.title = count ? t("imageWorkbench.runningTabTitle", { count }) : defaultTitleRef.current;
        };
        if (!document.hidden) syncTitle();
        document.addEventListener("visibilitychange", syncTitle);
        return () => document.removeEventListener("visibilitychange", syncTitle);
    }, [activeBatchIds.length, t]);

    useEffect(() => {
        previewLogIdRef.current = previewLog?.id ?? "";
    }, [previewLog]);

    // 活跃批次走 SSE 推送：任务状态变化时服务端立刻下发快照，任务全部结束后服务端关闭连接；
    // 连接异常时 watchGenerationBatch 内部会退化为轮询兜底。
    useEffect(() => {
        const cleanups = activeBatchIds.map((batchId) => watchGenerationBatch(batchId, (detail) => {
            const applied = applyDetailRef.current(detail);
            if (previewLogIdRef.current === batchId) {
                setPreviewLog(applied.log);
                setResults(applied.results);
            }
        }));
        return () => cleanups.forEach((cleanup) => cleanup());
    }, [activeBatchIds]);

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
        const agentTaskId = agentTasksRef.current.get(batchId);
        if (!agentTaskId) return;
        agentTasksRef.current.delete(batchId);
        const successCount = detail.tasks.filter((task) => task.status === "succeeded").length;
        updateAgentTask(agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount: detail.tasks.filter((task) => task.status === "failed" || task.status === "canceled").length, error: successCount ? undefined : detail.tasks.find((task) => task.errorMessage)?.errorMessage ?? undefined });
    };

    const applyDetail = (detail: GenerationBatchDetail) => {
        const applied = options.toLog(detail);
        options.onDetail?.(detail);
        setLogs((current) => [applied.log, ...current.filter((item) => item.id !== applied.log.id)].sort((a, b) => b.createdAt - a.createdAt));
        const active = applied.log.status === "pending";
        setActiveBatchIds((current) => {
            const rest = current.filter((id) => id !== applied.log.id);
            return active ? [...rest, applied.log.id] : rest;
        });
        if (active) watchedBatchesRef.current.add(applied.log.id);
        else if (watchedBatchesRef.current.delete(applied.log.id)) {
            settleAgentTask(applied.log.id, detail);
            notifyCompletion(detail);
        }
        return applied;
    };

    applyDetailRef.current = applyDetail;

    const watchBatch = (batchId: string) => {
        watchedBatchesRef.current.add(batchId);
        setActiveBatchIds((current) => (current.includes(batchId) ? current : [...current, batchId]));
    };

    const registerAgentTask = (batchId: string, agentTaskId: string) => {
        agentTasksRef.current.set(batchId, agentTaskId);
    };

    const deleteBatches = async (ids: string[]) => {
        const settled = await Promise.allSettled(ids.map((id) => deleteGenerationBatch(id)));
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

    return { logs, setLogs, activeBatchIds, setActiveBatchIds, activeBatchIdsRef, previewLog, setPreviewLog, previewLogIdRef, watchedBatchesRef, results, setResults, applyDetail, watchBatch, registerAgentTask, deleteBatches, ensureNotifyPermission };
}

// 生图/视频工作台共用的初始化：拉取模型、生成记录与偏好，并回填页面状态。
export function useWorkbenchBootstrap<L extends GenerationBatchLog, R>(options: {
    capability: "image" | "video";
    modelsRef: { current: PublicModel[] };
    preferencesRef: { current: Record<string, unknown> };
    batches: {
        setLogs: (logs: L[]) => void;
        setActiveBatchIds: (ids: string[]) => void;
        applyDetail: (detail: GenerationBatchDetail) => { log: L; results: R[] };
        setPreviewLog: (log: L) => void;
        setResults: (results: R[]) => void;
    };
    toLog: (batch: GenerationBatchListItem, models: PublicModel[]) => L;
    applyPreferences: (preferences: Record<string, unknown>, models: PublicModel[]) => void;
    resolveInitialBatchId: (batches: GenerationBatchListItem[]) => string | null | undefined;
    onBatch?: (batch: GenerationBatchListItem) => void;
    ignoreDetailError?: boolean;
}): { initialized: boolean } {
    const { message } = App.useApp();
    const [initialized, setInitialized] = useState(false);

    useEffect(() => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        let disposed = false;
        void Promise.all([fetchPublicModels(), getCapabilityBatches(options.capability), useConfigStore.getState().hydratePreferences()]).then(async ([availableModels, batchResp, preferences]) => {
            if (disposed || useUserStore.getState().sessionVersion !== sessionVersion) return;
            const batches = batchResp.batches;
            const models = availableModels.filter((item) => item.capability === options.capability);
            options.preferencesRef.current = preferences;
            options.modelsRef.current = models;
            options.applyPreferences(preferences, models);
            batches.forEach((batch) => options.onBatch?.(batch));
            options.batches.setLogs(batches.map((batch) => options.toLog(batch, models)));
            const activeBatches = batches.filter((batch) => batch.summary.activeCount > 0);
            if (activeBatches.length) options.batches.setActiveBatchIds(activeBatches.map((batch) => batch.id));
            const initialBatchId = options.resolveInitialBatchId(batches);
            if (!initialBatchId) return;
            try {
                const detail = await getGenerationBatch(initialBatchId);
                if (disposed || useUserStore.getState().sessionVersion !== sessionVersion) return;
                const applied = options.batches.applyDetail(detail);
                options.batches.setPreviewLog(applied.log);
                options.batches.setResults(applied.results);
            } catch (error) {
                if (!options.ignoreDetailError) throw error;
            }
        }).catch((error) => {
            if (!disposed && useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : "生成记录加载失败");
        }).finally(() => {
            if (!disposed && useUserStore.getState().sessionVersion === sessionVersion) setInitialized(true);
        });
        return () => { disposed = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { initialized };
}
