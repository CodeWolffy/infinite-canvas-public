import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { deleteGenerationBatch, getGenerationBatch, type GenerationBatchDetail, type GenerationTask } from "@/services/api/generation";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

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
    const pollRef = useRef<() => void>(() => {});
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

    useEffect(() => {
        if (!activeBatchIds.length) return;
        const timer = window.setInterval(() => pollRef.current(), 1800);
        return () => window.clearInterval(timer);
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

    const pollActiveBatches = async () => {
        await Promise.all(
            activeBatchIdsRef.current.map(async (batchId) => {
                try {
                    const applied = applyDetail(await getGenerationBatch(batchId));
                    if (previewLogIdRef.current === batchId) {
                        setPreviewLog(applied.log);
                        setResults(applied.results);
                    }
                } catch {
                    return;
                }
            }),
        );
    };
    pollRef.current = () => void pollActiveBatches();

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
