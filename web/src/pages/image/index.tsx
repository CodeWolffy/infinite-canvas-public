import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Select, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { saveAs } from "file-saver";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { createZip } from "@/lib/zip";
import { modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { createGenerationBatch, deleteGenerationBatch, getGenerationBatch, getGenerationPreferences, getPublicModels, listGenerationBatches, retryGenerationTask, updateGenerationPreferences, uploadGenerationMedia, type GenerationBatchDetail, type GenerationBatchListItem, type GenerationTask, type PublicModel } from "@/services/api/generation";
import { platformImageParameters, resolvePlatformImageModelId } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "queued" | "running" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "pending" | "success" | "failed";
    images: GeneratedImage[];
    thumbnails: string[];
    results: GenerationResult[];
    referenceMediaIds: string[];
    modelId: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export default function ImagePage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const remixState = location.state as { prompt?: string; modelId?: string } | null;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [models, setModels] = useState<PublicModel[]>([]);
    const modelsRef = useRef<PublicModel[]>([]);
    const [modelId, setModelId] = useState(remixState?.modelId || "");
    const [initialized, setInitialized] = useState(false);
    const [prompt, setPrompt] = useState(remixState?.prompt || "");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [activeBatchIds, setActiveBatchIds] = useState<string[]>([]);
    const activeBatchIdsRef = useRef<string[]>([]);
    const previewLogIdRef = useRef("");
    const agentTasksRef = useRef(new Map<string, string>());
    const watchedBatchesRef = useRef(new Set<string>());
    const defaultTitleRef = useRef(document.title);
    const pollRef = useRef<() => void>(() => {});
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const preferencesRef = useRef<Record<string, unknown>>({});

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
        const sessionVersion = useUserStore.getState().sessionVersion;
        let disposed = false;
        void Promise.all([getPublicModels(), listGenerationBatches(), getGenerationPreferences()]).then(async ([availableModels, batchPage, preferences]) => {
            if (disposed || useUserStore.getState().sessionVersion !== sessionVersion) return;
            const batches = batchPage.batches;
            preferencesRef.current = preferences;
            const imageModels = availableModels.filter((item) => item.capability === "image");
            modelsRef.current = imageModels;
            setModels(imageModels);
            const preferredModelId = typeof preferences.imageModelId === "string" && imageModels.some((item) => item.id === preferences.imageModelId) ? preferences.imageModelId : imageModels[0]?.id || "";
            setModelId((current) => current || preferredModelId);
            for (const key of ["quality", "size", "count", "background"] as const) {
                if (typeof preferences[key] === "string") updateConfig(key, preferences[key]);
            }
            setLogs(batches.map((batch) => summaryToLog(batch, imageModels)));
            const activeBatches = batches.filter((batch) => batch.summary.activeCount > 0);
            if (!activeBatches.length) return;
            setActiveBatchIds(activeBatches.map((b) => b.id));
            const detail = await getGenerationBatch(activeBatches[0]!.id);
            if (disposed || useUserStore.getState().sessionVersion !== sessionVersion) return;
            const applied = applyDetail(detail);
            setPreviewLog(applied.log);
            setResults(applied.results);
        }).catch((error) => {
            if (!disposed && useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : "生成记录加载失败");
        }).finally(() => {
            if (!disposed && useUserStore.getState().sessionVersion === sessionVersion) setInitialized(true);
        });
        return () => { disposed = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!activeBatchIds.length) return;
        const timer = window.setInterval(() => pollRef.current(), 1800);
        return () => window.clearInterval(timer);
    }, [activeBatchIds]);

    const activeModel = models.find((item) => item.id === modelId);
    const canGenerate = Boolean(prompt.trim() && modelId);
    const generationCount = Math.max(1, Math.min(20, Number(config.count) || 1));
    const failedResultIndexes = results.flatMap((item, index) => (item.status === "failed" ? [index] : []));
    const successImages = results.flatMap((item) => (item.status === "success" && item.image ? [item.image] : []));

    const ensureNotifyPermission = () => {
        if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    };

    const notifyCompletion = (detail: GenerationBatchDetail) => {
        const successCount = detail.tasks.filter((task) => task.status === "succeeded").length;
        if (successCount) message.success(t("imageWorkbench.generated"));
        else message.error(detail.tasks.find((task) => task.errorMessage)?.errorMessage || t("workbench.generationFailed"));
        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
            document.title = t("imageWorkbench.completedTabTitle");
            const notification = new Notification(t("imageWorkbench.notificationTitle"), { body: detail.batch.prompt.slice(0, 80), icon: "/logo.svg" });
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
        const log = detailToLog(detail, modelsRef.current);
        setLogs((current) => [log, ...current.filter((item) => item.id !== log.id)].sort((a, b) => b.createdAt - a.createdAt));
        const active = log.status === "pending";
        setActiveBatchIds((current) => {
            const rest = current.filter((id) => id !== log.id);
            return active ? [...rest, log.id] : rest;
        });
        if (active) watchedBatchesRef.current.add(log.id);
        else if (watchedBatchesRef.current.delete(log.id)) {
            settleAgentTask(log.id, detail);
            notifyCompletion(detail);
        }
        return { log, results: detail.tasks.map(taskToResult) };
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

    const addReferences = async (files?: FileList | null) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        try {
            const imageFiles = Array.from(files || []).filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const media = await uploadGenerationMedia(file, file.name);
                    return { id: nanoid(), name: file.name, type: media.mimeType, dataUrl: media.url, storageKey: media.id };
                }),
            );
            assertCurrentSession(sessionVersion);
            setReferences((value) => [...value, ...nextReferences]);
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.error(error instanceof Error ? error.message : "参考图上传失败");
        }
    };

    const addReferencesFromClipboard = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => SUPPORTED_IMAGE_TYPES.has(type)).map((type) => item.getType(type))));
            assertCurrentSession(sessionVersion);
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const media = await uploadGenerationMedia(blob, `clipboard-${index + 1}.png`);
                    return { id: nanoid(), name: media.originalName, type: media.mimeType, dataUrl: media.url, storageKey: media.id };
                }),
            );
            assertCurrentSession(sessionVersion);
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.error(error instanceof Error ? error.message : t("imageWorkbench.clipboardEmpty"));
        }
    };

    const generate = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!modelId) {
            message.warning(t("imageWorkbench.noModelHint"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.noModelHint") });
            return;
        }
        try {
            ensureNotifyPermission();
            const referenceMediaIds = references.map((item) => item.storageKey).filter((id): id is string => Boolean(id));
            const resolvedModelId = await resolvePlatformImageModelId(modelId);
            assertCurrentSession(sessionVersion);
            const created = await createGenerationBatch({ modelId: resolvedModelId, prompt: text, count: generationCount, parameters: generationParameters(effectiveConfig), referenceMediaIds });
            assertCurrentSession(sessionVersion);
            const applied = applyDetail({ ...created, referenceMediaIds });
            setPreviewLog(applied.log);
            setResults(applied.results);
            if (agentTaskId) {
                agentTasksRef.current.set(created.batch.id, agentTaskId);
                updateAgentTask(agentTaskId, { status: "running", error: undefined });
            }
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            const detail = error instanceof Error ? error.message : t("workbench.generationFailed");
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: detail });
            message.error(detail);
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!initialized || !imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (imageCommand.config?.model) setModelId(modelOptionName(imageCommand.config.model));
        for (const key of ["quality", "size", "count"] as const) {
            const value = imageCommand.config?.[key];
            if (typeof value === "string") updateConfig(key, value);
        }
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, initialized, updateConfig]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `${fileBaseName(prompt)}-${String(index + 1).padStart(2, "0")}.${fileExtension(image.mimeType)}`);
    };

    const downloadBatchZip = async () => {
        if (!successImages.length) return;
        const files = await Promise.all(
            successImages.map(async (image, index) => ({
                name: `${String(index + 1).padStart(2, "0")}.${fileExtension(image.mimeType)}`,
                data: await (await fetch(image.dataUrl)).blob(),
            })),
        );
        saveAs(await createZip(files), `${fileBaseName(prompt)}.zip`);
        message.success(t("imageWorkbench.zipDownloaded", { count: files.length }));
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: image.mimeType || "image/png", dataUrl: image.dataUrl, storageKey: image.storageKey }]);
        message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        try {
            const stored = await uploadImage(image.dataUrl);
            assertCurrentSession(sessionVersion);
            await addAsset({
                kind: "image",
                title: t("imageWorkbench.resultTitle", { count: index + 1 }),
                coverUrl: stored.url,
                tags: [],
                source: t("imageWorkbench.source"),
                data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
                metadata: { source: "image-page", prompt },
            });
            assertCurrentSession(sessionVersion);
            message.success(t("common.addedToAssets"));
        } catch {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.error(t("common.requestFailed") || "加入素材失败，请重试");
        }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const existingId = payload.storageKey?.replace(/^image:/, "");
            if (existingId) {
                setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: "image", dataUrl: `/api/media/${existingId}`, storageKey: existingId }]);
            } else {
                const blob = await (await fetch(payload.dataUrl)).blob();
                assertCurrentSession(sessionVersion);
                const media = await uploadGenerationMedia(blob, `${payload.title}.png`);
                assertCurrentSession(sessionVersion);
                setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: media.mimeType, dataUrl: media.url, storageKey: media.id }]);
            }
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setResults([]);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const selected = logs.filter((log) => selectedLogIds.includes(log.id));
        if (!selected.length) return;
        if (selected.some((log) => log.status === "pending")) {
            message.warning("进行中的生成任务不能删除");
            return;
        }
        modal.confirm({
            title: `删除选中的 ${selected.length} 条生成记录？`,
            content: "已被画布或素材引用的图片仍会保留。",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const results = await Promise.allSettled(selected.map((log) => deleteGenerationBatch(log.id)));
                const deletedIds = selected.flatMap((log, index) => results[index]?.status === "fulfilled" ? [log.id] : []);
                if (deletedIds.length) {
                    const deleted = new Set(deletedIds);
                    setLogs((current) => current.filter((log) => !deleted.has(log.id)));
                    setSelectedLogIds((current) => current.filter((id) => !deleted.has(id)));
                    if (previewLog && deleted.has(previewLog.id)) createSession();
                    message.success(`已删除 ${deletedIds.length} 条生成记录`);
                }
                const failure = results.find((result) => result.status === "rejected");
                if (failure?.status === "rejected") message.error(failure.reason instanceof Error ? failure.reason.message : "部分记录删除失败");
            },
        });
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        try {
            setLogsOpen(false);
            const applied = applyDetail(await getGenerationBatch(log.id));
            setPreviewLog(applied.log);
            setResults(applied.results);
            if (applied.log.status !== "pending") {
                updateConfig("quality", applied.log.quality || "auto");
                updateConfig("size", applied.log.size || "auto");
                updateConfig("count", String(applied.log.imageCount));
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成记录读取失败");
        }
    };

    const retryResults = async (indexes: number[]) => {
        const targets = indexes.map((index) => ({ index, id: results[index]!.id }));
        const settled = await Promise.allSettled(targets.map(({ id }) => retryGenerationTask(id)));
        const retriedIds = new Set(settled.flatMap((result, position) => (result.status === "fulfilled" ? [targets[position]!.id] : [])));
        if (retriedIds.size) {
            setResults((value) => value.map((item) => (retriedIds.has(item.id) ? { ...item, status: "queued" as const, error: undefined, image: undefined } : item)));
            const batchId = previewLogIdRef.current;
            if (batchId) {
                watchedBatchesRef.current.add(batchId);
                setActiveBatchIds((current) => (current.includes(batchId) ? current : [...current, batchId]));
            }
        }
        const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) message.error(failure.reason instanceof Error ? failure.reason.message : t("workbench.generationFailed"));
    };

    const selectModel = (value: string) => {
        setModelId(value);
        const preferences = { ...preferencesRef.current, imageModelId: value };
        preferencesRef.current = preferences;
        void updateGenerationPreferences(preferences).catch(() => undefined);
    };

    const updateGenerationConfig: UpdateAiConfig = (key, value) => {
        updateConfig(key, value);
        if (!["quality", "size", "count", "background"].includes(key)) return;
        const preferences = { ...preferencesRef.current, [key]: value };
        preferencesRef.current = preferences;
        void updateGenerationPreferences(preferences).catch(() => undefined);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={deleteSelectedLogs}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("imageWorkbench.title")}</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        {t("workbench.logs")}
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        {t("workbench.settings")}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("workbench.prompt")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("imageWorkbench.promptPlaceholder")} />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("imageWorkbench.references")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("imageWorkbench.removeReference")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {activeModel?.displayName || "请选择模型"} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} models={models} modelId={modelId} onModelChange={selectModel} updateConfig={updateGenerationConfig} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={() => void generate()}>
                                {t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                            </div>
                            <div className="flex items-center gap-2">
                                {failedResultIndexes.length > 1 ? (
                                    <Button size="small" danger icon={<RefreshCw className="size-3.5" />} onClick={() => void retryResults(failedResultIndexes)}>
                                        {t("imageWorkbench.retryFailed", { count: failedResultIndexes.length })}
                                    </Button>
                                ) : null}
                                {successImages.length > 1 ? (
                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void downloadBatchZip()}>
                                        {t("imageWorkbench.downloadAll")}
                                    </Button>
                                ) : null}
                                {activeBatchIds.length ? <Tag className="m-0 px-2 py-1">{t("imageWorkbench.batchInProgress", { count: activeBatchIds.length })}</Tag> : null}
                            </div>
                        </div>
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "queued" || result.status === "running" ? (
                                        <PendingImageCard key={result.id} status={result.status} />
                                    ) : (
                                        <FailedImageCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => void retryResults([index])} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={deleteSelectedLogs}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} models={models} modelId={modelId} onModelChange={selectModel} updateConfig={updateGenerationConfig} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
        </div>
    );
}

function GenerationSettings({ config, models, modelId, onModelChange, updateConfig }: { config: AiConfig; models: PublicModel[]; modelId: string; onModelChange: (value: string) => void; updateConfig: UpdateAiConfig }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                {models.length ? (
                    <Select value={modelId || undefined} onChange={onModelChange} placeholder={t("imageWorkbench.noModelHint")} className="w-full" options={models.map((model) => ({ value: model.id, label: model.displayName }))} />
                ) : (
                    <Typography.Text type="warning" className="block text-xs leading-5">
                        {t("imageWorkbench.noModelHint")}
                    </Typography.Text>
                )}
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={20} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={image.dataUrl} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square object-cover" />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    {image.width && image.height ? <span>{image.width}x{image.height}</span> : null}
                    {image.bytes ? <span>{formatBytes(image.bytes)}</span> : null}
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ status }: { status: "queued" | "running" }) {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{status === "queued" ? "排队中" : t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function fileBaseName(text: string) {
    const cleaned = text.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 24);
    return `${cleaned || "image"}-${dayjs().format("YYYYMMDD-HHmmss")}`;
}

function fileExtension(mimeType?: string) {
    return mimeType?.split("/")[1]?.replace("jpeg", "jpg") || "png";
}

function summaryToLog(batch: GenerationBatchListItem, models: PublicModel[]): GenerationLog {
    const parameters = batch.parameters || {};
    const model = models.find((item) => item.id === batch.modelId);
    return {
        id: batch.id,
        createdAt: new Date(batch.createdAt).getTime(),
        title: batch.prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt: batch.prompt,
        time: new Date(batch.createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: model?.displayName || model?.name || batch.modelId,
        modelId: batch.modelId,
        config: { model: batch.modelId, imageModel: batch.modelId, quality: String(parameters.quality || "auto"), size: String(parameters.size || "auto"), count: String(batch.requestedCount) },
        references: [],
        referenceMediaIds: [],
        durationMs: 0,
        successCount: batch.summary.succeededCount,
        failCount: batch.summary.failedCount,
        imageCount: batch.requestedCount,
        size: String(parameters.size || "auto"),
        quality: String(parameters.quality || "auto"),
        status: batch.summary.activeCount > 0 ? "pending" : batch.summary.succeededCount > 0 ? "success" : batch.summary.failedCount > 0 ? "failed" : "success",
        images: [],
        results: [],
        thumbnails: batch.summary.thumbnailMediaIds.map((mediaId) => `/api/media/${mediaId}`),
    };
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    const thumbnails = (log.thumbnails || []).filter(Boolean).slice(0, 4);

    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image, index) => (
                                    <img key={`${log.id}-${index}`} src={image} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                {t("workbench.failCount", { count: log.failCount })}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                        {log.durationMs ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                                {formatDuration(log.durationMs)}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

function generationParameters(config: AiConfig) {
    return platformImageParameters(config);
}

function isActiveTask(task: GenerationTask) {
    return task.status === "queued" || task.status === "running";
}

function taskToResult(task: GenerationTask): GenerationResult {
    if (task.status === "succeeded" && task.image) {
        return { id: task.id, status: "success", image: { id: task.id, dataUrl: task.image.url, storageKey: task.image.mediaId, durationMs: taskDuration(task), width: 0, height: 0, bytes: 0 } };
    }
    if (task.status === "failed" || task.status === "canceled") return { id: task.id, status: "failed", error: task.errorMessage || task.errorCode || i18n.t("workbench.generationFailed") };
    return { id: task.id, status: task.status === "running" ? "running" : "queued" };
}

function detailToLog(detail: GenerationBatchDetail, models: PublicModel[]): GenerationLog {
    const parameters = detail.batch.parameters || {};
    const results = detail.tasks.map(taskToResult);
    const images = results.flatMap((result) => result.image ? [result.image] : []);
    const successCount = detail.tasks.filter((task) => task.status === "succeeded").length;
    const failCount = detail.tasks.filter((task) => task.status === "failed" || task.status === "canceled").length;
    const active = detail.tasks.some(isActiveTask);
    const model = models.find((item) => item.id === detail.batch.modelId);
    return {
        id: detail.batch.id,
        createdAt: new Date(detail.batch.createdAt).getTime(),
        title: detail.batch.prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt: detail.batch.prompt,
        time: new Date(detail.batch.createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: detail.tasks[0]?.modelDisplayName || detail.tasks[0]?.modelName || model?.displayName || model?.name || detail.batch.modelId,
        modelId: detail.batch.modelId,
        config: { model: detail.batch.modelId, imageModel: detail.batch.modelId, quality: String(parameters.quality || "auto"), size: String(parameters.size || "auto"), count: String(detail.batch.requestedCount) },
        references: detail.referenceMediaIds.map((mediaId, index) => ({ id: mediaId, name: `reference-${index + 1}`, type: "image", dataUrl: `/api/media/${mediaId}`, storageKey: mediaId })),
        referenceMediaIds: detail.referenceMediaIds,
        durationMs: Math.max(0, ...detail.tasks.map(taskDuration)),
        successCount,
        failCount,
        imageCount: detail.batch.requestedCount,
        size: String(parameters.size || "auto"),
        quality: String(parameters.quality || "auto"),
        status: active ? "pending" : successCount ? "success" : "failed",
        images,
        results,
        thumbnails: images.map((image) => image.dataUrl),
    };
}

function taskDuration(task: GenerationTask) {
    const startedAt = task.startedAt || task.queuedAt;
    const finishedAt = task.finishedAt || (isActiveTask(task) ? new Date().toISOString() : startedAt);
    return Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}
