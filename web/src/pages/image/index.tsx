import { BookOpen, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Drawer, Empty, Image, Input, Tag, Tooltip, Typography } from "antd";
import { saveAs } from "file-saver";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { LogPanel } from "@/components/generation/log-panel";
import { ReferenceOrderButtons } from "@/components/generation/reference-order-buttons";
import { canvasThemes } from "@/lib/canvas-theme";
import { fileBaseName, fileExtension, moveListItem, summaryLogBase, type GenerationLog } from "@/lib/generation-log";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { createZip } from "@/lib/zip";
import { modelOptionLabel, modelOptionName, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { createGenerationBatch, getGenerationBatch, retryGenerationTask, updateGenerationPreferences, uploadGenerationMedia, type GenerationBatchDetail, type GenerationBatchListItem, type GenerationTask, type PublicModel } from "@/services/api/generation";
import { platformImageParameters } from "@/services/api/image";
import { selectedPlatformModel } from "@/services/api/tasks";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useGenerationBatches, useWorkbenchBootstrap, isActiveGenerationTask, generationTaskDuration } from "@/hooks/use-generation-batches";
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
    status: "reviewing" | "queued" | "running" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export default function ImagePage() {
    const { message, modal } = App.useApp();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const { t } = useTranslation();
    const location = useLocation();
    const remixState = location.state as { prompt?: string; modelId?: string } | null;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const addAsset = useAssetStore((state) => state.addAsset);
    const modelsRef = useRef<PublicModel[]>([]);
    const { logs, setLogs, activeBatchIds, setActiveBatchIds, previewLog, setPreviewLog, previewLogIdRef, results, setResults, applyDetail, watchBatch, registerAgentTask, deleteBatches, ensureNotifyPermission } = useGenerationBatches({
        toLog: (detail) => ({ log: detailToLog(detail, modelsRef.current), results: detail.tasks.map(taskToResult) }),
        onDetail: (detail) => {
            detail.tasks.forEach((task) => {
                if (task.image?.mediaId) void ensureImagePreview(task.image.mediaId);
            });
            detail.referenceMediaIds.forEach((id) => void ensureImagePreview(id));
        },
        notifyKeys: { success: "imageWorkbench.generated", title: "imageWorkbench.notificationTitle" },
    });
    const [modelId, setModelId] = useState(remixState?.modelId || "");
    const [prompt, setPrompt] = useState(remixState?.prompt || "");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const [generating, setGenerating] = useState(false);
    const generatingRef = useRef(false);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const preferencesRef = useRef<Record<string, unknown>>({});
    const { initialized } = useWorkbenchBootstrap({
        capability: "image",
        modelsRef,
        preferencesRef,
        batches: { setLogs, setActiveBatchIds, applyDetail, setPreviewLog, setResults },
        toLog: (batch, models) => summaryToLog(batch, models),
        applyPreferences: (preferences, models) => {
            const preferredModelId = typeof preferences.imageModelId === "string" && preferences.imageModelId ? preferences.imageModelId : models[0]?.id || "";
            const initialModel = remixState?.modelId || preferredModelId;
            setModelId(initialModel);
            if (initialModel) updateConfig("imageModel", initialModel);
            for (const key of ["quality", "size", "count", "background"] as const) {
                if (typeof preferences[key] === "string") updateConfig(key, preferences[key]);
            }
        },
        resolveInitialBatchId: (batches) => batches.find((batch) => batch.summary.activeCount > 0)?.id,
        onBatch: (batch) => batch.summary.thumbnailMediaIds.forEach((id) => void ensureImagePreview(id)),
    });

    const model = modelId || effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim() && model && !generating);
    const generationCount = Math.max(1, Math.min(20, Number(config.count) || 1));
    const failedResultIndexes = results.flatMap((item, index) => (item.status === "failed" ? [index] : []));
    const successImages = results.flatMap((item) => (item.status === "success" && item.image ? [item.image] : []));

    const addReferences = async (files?: FileList | null) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        try {
            const imageFiles = Array.from(files || []).filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const media = await uploadGenerationMedia(file, file.name);
                    void ensureImagePreview(media.id);
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
                    void ensureImagePreview(media.id);
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
        if (generatingRef.current) return;
        generatingRef.current = true;
        setGenerating(true);
        const sessionVersion = useUserStore.getState().sessionVersion;
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            generatingRef.current = false;
            setGenerating(false);
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        const currentModel = model;
        if (!currentModel) {
            generatingRef.current = false;
            setGenerating(false);
            message.warning(t("imageWorkbench.noModelHint"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.noModelHint") });
            return;
        }
        try {
            ensureNotifyPermission();
            const referenceMediaIds = references.map((item) => item.storageKey).filter((id): id is string => Boolean(id));
            const targetModelId = selectedPlatformModel(modelsRef.current, currentModel, "image");
            assertCurrentSession(sessionVersion);
            const created = await createGenerationBatch({ modelId: targetModelId, prompt: text, count: generationCount, parameters: platformImageParameters(effectiveConfig), referenceMediaIds });
            assertCurrentSession(sessionVersion);
            const applied = applyDetail({ ...created, referenceMediaIds });
            setPreviewLog(applied.log);
            setResults(applied.results);
            if (agentTaskId) {
                registerAgentTask(created.batch.id, agentTaskId);
                updateAgentTask(agentTaskId, { status: "running", error: undefined });
            }
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            const detail = error instanceof Error ? error.message : t("workbench.generationFailed");
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: detail });
            message.error(detail);
        } finally {
            generatingRef.current = false;
            setGenerating(false);
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!initialized || !imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (imageCommand.config?.model) {
            const nextModel = modelOptionName(imageCommand.config.model);
            setModelId(nextModel);
            updateConfig("imageModel", nextModel);
        }
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
        if (image.storageKey) void ensureImagePreview(image.storageKey);
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
                const deletedIds = await deleteBatches(selected.map((log) => log.id));
                if (deletedIds.length) {
                    setSelectedLogIds((current) => current.filter((id) => !deletedIds.includes(id)));
                    if (previewLog && deletedIds.includes(previewLog.id)) createSession();
                }
            },
        });
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        try {
            setLogsOpen(false);
            const applied = applyDetail(await getGenerationBatch(log.id));
            setPreviewLog(applied.log);
            setResults(applied.results);
            if (applied.log.config.imageModel || applied.log.modelId) {
                const loadedModel = applied.log.config.imageModel || applied.log.modelId;
                setModelId(loadedModel);
                updateConfig("imageModel", loadedModel);
            }
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
            if (previewLogIdRef.current) watchBatch(previewLogIdRef.current);
        }
        const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) message.error(failure.reason instanceof Error ? failure.reason.message : t("workbench.generationFailed"));
    };


    const updateGenerationConfig: UpdateAiConfig = (key, value) => {
        updateConfig(key, value);
        if (key === "imageModel" && typeof value === "string") {
            setModelId(value);
        }
        if (!["quality", "size", "count", "background", "imageModel"].includes(key)) return;
        const preferences = { [key === "imageModel" ? "imageModelId" : key]: key === "imageModel" && typeof value === "string" ? modelOptionName(value) : value };
        preferencesRef.current = { ...preferencesRef.current, ...preferences };
        void updateGenerationPreferences(preferences).catch(() => undefined);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        variant="image"
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
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
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
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden space-y-4 sm:block">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateGenerationConfig} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={generating} disabled={!canGenerate || generating} onClick={() => void generate()}>
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
                                    ) : result.status === "reviewing" || result.status === "queued" || result.status === "running" ? (
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
                    variant="image"
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={deleteSelectedLogs}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" height="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="space-y-4 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateGenerationConfig} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig }) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <div className="space-y-4">
            <label className="block min-w-0">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => message.warning(t("imageWorkbench.noModelHint"))} />
            </label>
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="w-full space-y-4" maxCount={20} />
        </div>
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
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={previewUrlFor(image.storageKey) || image.dataUrl} preview={{ src: image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square object-cover" />
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

function PendingImageCard({ status }: { status: "reviewing" | "queued" | "running" }) {
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
                <span>{status === "reviewing" ? "待内容审核" : status === "queued" ? "排队中" : t("workbench.generating")}</span>
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

function summaryToLog(batch: GenerationBatchListItem, models: PublicModel[]): GenerationLog {
    const parameters = batch.parameters || {};
    return {
        ...summaryLogBase(batch, models),
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
        thumbnailMediaIds: batch.summary.thumbnailMediaIds,
        thumbnails: batch.summary.thumbnailMediaIds.map((mediaId) => `/api/media/${mediaId}`),
    };
}

function taskToResult(task: GenerationTask): GenerationResult {
    if (task.status === "succeeded" && task.image) {
        return { id: task.id, status: "success", image: { id: task.id, dataUrl: task.image.url, storageKey: task.image.mediaId, durationMs: generationTaskDuration(task), width: 0, height: 0, bytes: 0 } };
    }
    if (task.status === "failed" || task.status === "canceled") return { id: task.id, status: "failed", error: task.errorMessage || task.errorCode || i18n.t("workbench.generationFailed") };
    return { id: task.id, status: task.status === "reviewing" ? "reviewing" : task.status === "running" ? "running" : "queued" };
}

function detailToLog(detail: GenerationBatchDetail, models: PublicModel[]): GenerationLog {
    const parameters = detail.batch.parameters || {};
    const results = detail.tasks.map(taskToResult);
    const images = results.flatMap((result) => result.image ? [result.image] : []);
    const successCount = detail.tasks.filter((task) => task.status === "succeeded").length;
    const failCount = detail.tasks.filter((task) => task.status === "failed" || task.status === "canceled").length;
    const active = detail.tasks.some(isActiveGenerationTask);
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
        durationMs: Math.max(0, ...detail.tasks.map(generationTaskDuration)),
        successCount,
        failCount,
        imageCount: detail.batch.requestedCount,
        size: String(parameters.size || "auto"),
        quality: String(parameters.quality || "auto"),
        status: active ? "pending" : successCount ? "success" : "failed",
        images,
        results,
        thumbnailMediaIds: images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)),
        thumbnails: images.map((image) => image.dataUrl),
    };
}


