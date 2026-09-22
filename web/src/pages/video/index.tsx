import { BookOpen, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { App, Button, Drawer, Empty, Input, Tag, Typography } from "antd";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { LogPanel } from "@/components/generation/log-panel";
import { ReferenceOrderButtons } from "@/components/generation/reference-order-buttons";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, videoModeLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { moveListItem, summaryLogBase, type GenerationLog } from "@/lib/generation-log";
import { clampVideoSeconds, computeVideoSize } from "@/lib/media-size";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews } from "@/services/image-storage";
import { createGenerationBatch, getGenerationBatch, retryGenerationTask, updateGenerationPreferences, uploadGenerationMedia, type GenerationBatchDetail, type GenerationBatchListItem, type GenerationTask, type PublicModel } from "@/services/api/generation";
import { selectedPlatformModel } from "@/services/api/tasks";
import { useSaveToAssets } from "@/hooks/use-save-to-assets";
import { useGenerationBatches, useWorkbenchBootstrap, isActiveGenerationTask, generationTaskDuration } from "@/hooks/use-generation-batches";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { boolConfig, modelOptionLabel, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

type GeneratedVideo = {
    id: string;
    url: string;
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
    video?: GeneratedVideo;
    error?: string;
};

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

export default function VideoPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [searchParams] = useSearchParams();
    const targetBatchId = searchParams.get("batch");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const effectiveConfig = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const addAsset = useSaveToAssets();

    const modelsRef = useRef<PublicModel[]>([]);
    const { logs, setLogs, activeBatchIds, setActiveBatchIds, previewLog, setPreviewLog, previewLogIdRef, results, setResults, applyDetail, watchBatch, registerAgentTask, deleteBatches, ensureNotifyPermission } = useGenerationBatches({
        toLog: (detail) => detailToLog(detail, modelsRef.current),
        onDetail: (detail) => detail.referenceMediaIds.forEach((id) => void ensureImagePreview(id)),
        notifyKeys: { success: "videoWorkbench.generated", title: "videoWorkbench.title" },
    });
    const preferencesRef = useRef<Record<string, unknown>>({});
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [generating, setGenerating] = useState(false);
    const generatingRef = useRef(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [referenceDragTarget, setReferenceDragTarget] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);

    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim() && !generating);

    const { initialized } = useWorkbenchBootstrap({
        capability: "video",
        modelsRef,
        preferencesRef,
        batches: { setLogs, setActiveBatchIds, applyDetail, setPreviewLog, setResults },
        toLog: (batch, models) => summaryToLog(batch, models),
        applyPreferences: (preferences, models) => {
            if (typeof preferences.videoModelId === "string" && models.some((item) => item.id === preferences.videoModelId)) {
                updateConfig("videoModel", preferences.videoModelId);
            }
            for (const key of ["vquality", "videoSeconds", "videoGenerateAudio", "videoWatermark", "videoMode"] as const) {
                if (typeof preferences[key] === "string") updateConfig(key, preferences[key]);
            }
            if (typeof preferences.videoSize === "string") updateConfig("size", preferences.videoSize);
        },
        resolveInitialBatchId: (batches) => targetBatchId || batches[0]?.id || null,
        ignoreDetailError: true,
    });

    const addReferences = async (files?: FileList | null) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const validFiles = selectedFiles.filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/")).slice(0, 9 - references.length);
        try {
            const nextReferences = await Promise.all(
                validFiles.map(async (file) => {
                    const media = await uploadGenerationMedia(file, file.name);
                    void ensureImagePreview(media.id);
                    return { id: nanoid(), name: file.name, type: media.mimeType, dataUrl: media.url, storageKey: media.id };
                }),
            );
            assertCurrentSession(sessionVersion);
            setReferences((value) => [...value, ...nextReferences].slice(0, 9));
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.error(error instanceof Error ? error.message : "参考文件上传失败");
        }
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(false);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            assertCurrentSession(sessionVersion);
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.slice(0, 9 - references.length).map(async (blob, index) => {
                    const media = await uploadGenerationMedia(blob, `clipboard-${index + 1}.png`);
                    void ensureImagePreview(media.id);
                    return { id: nanoid(), name: media.originalName, type: media.mimeType, dataUrl: media.url, storageKey: media.id };
                }),
            );
            assertCurrentSession(sessionVersion);
            setReferences((value) => [...value, ...nextReferences].slice(0, 9));
            message.success(t("videoWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.error(error instanceof Error ? error.message : t("videoWorkbench.clipboardEmpty"));
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
            message.error(t("videoWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.promptRequired") });
            return;
        }
        const currentModel = effectiveConfig.videoModel || effectiveConfig.model;
        if (!currentModel) {
            generatingRef.current = false;
            setGenerating(false);
            message.warning("请选择视频模型");
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: "请选择视频模型" });
            return;
        }

        try {
            ensureNotifyPermission();
            const referenceMediaIds = references.map((item) => item.storageKey).filter((id): id is string => Boolean(id));
            const modelId = selectedPlatformModel(modelsRef.current, currentModel, "video");
            const seconds = Number(clampVideoSeconds(effectiveConfig.videoSeconds || "6"));
            const size = /^\d+x\d+$/.test(effectiveConfig.size) ? effectiveConfig.size : computeVideoSize(effectiveConfig.vquality, effectiveConfig.size);
            const parameters = {
                seconds: String(seconds),
                size,
                resolution_name: effectiveConfig.vquality || "720",
                mode: effectiveConfig.videoMode === "reference" ? "reference" : "frames",
                generate_audio: boolConfig(effectiveConfig.videoGenerateAudio, true),
                watermark: boolConfig(effectiveConfig.videoWatermark, false),
            };
            assertCurrentSession(sessionVersion);
            const created = await createGenerationBatch({
                modelId,
                prompt: text,
                count: 1,
                referenceMediaIds,
                parameters,
            });
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

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!initialized || !videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.config?.model) updateConfig("videoModel", videoCommand.config.model);
        if (videoCommand.config?.size) updateConfig("size", videoCommand.config.size);
        if (videoCommand.config?.seconds) updateConfig("videoSeconds", String(videoCommand.config.seconds));
        if (videoCommand.config?.resolution) updateConfig("vquality", String(videoCommand.config.resolution));
        if (videoCommand.config?.mode) updateConfig("videoMode", videoCommand.config.mode);
        if (videoCommand.run && generating) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, initialized, generating, updateAgentTask, updateConfig, t]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const retryResult = async (taskId?: string) => {
        const targetId = taskId || results.find((r) => r.status === "failed")?.id;
        if (!targetId) return;
        try {
            const retried = await retryGenerationTask(targetId);
            setResults((value) => value.map((item) => (item.id === targetId ? { id: retried.id, status: "queued" } : item)));
            if (previewLogIdRef.current) watchBatch(previewLogIdRef.current);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workbench.generationFailed"));
        }
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4" },
            metadata: { source: "video-page", prompt },
        });
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image" || payload.kind === "video" || payload.kind === "audio") {
            const existingId = payload.storageKey?.replace(/^(?:image:|media:)/, "");
            if (existingId) {
                setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: payload.kind, dataUrl: `/api/media/${existingId}`, storageKey: existingId }].slice(0, 9));
            } else {
                try {
                    const sourceUrl = "dataUrl" in payload ? payload.dataUrl : "url" in payload ? payload.url : "";
                    if (!sourceUrl) throw new Error("no url");
                    const blob = await (await fetch(sourceUrl)).blob();
                    assertCurrentSession(sessionVersion);
                    const media = await uploadGenerationMedia(blob, `${payload.title}.png`);
                    assertCurrentSession(sessionVersion);
                    setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: media.mimeType, dataUrl: media.url, storageKey: media.id }].slice(0, 9));
                } catch {
                    message.error("资产读取失败");
                }
            }
        } else {
            message.warning("不支持的资产类型");
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
            title: `确定删除选中的 ${selected.length} 条生成记录吗？`,
            content: "删除后会从生成记录中移除。",
            okText: t("common.delete"),
            cancelText: t("common.cancel"),
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
            setPrompt(applied.log.prompt);
            setReferences(applied.log.references || []);
            if (applied.log.config.videoModel || applied.log.modelId) {
                updateConfig("videoModel", applied.log.config.videoModel || applied.log.modelId);
            }
            if (applied.log.config.size) updateConfig("size", applied.log.config.size);
            if (applied.log.config.vquality) updateConfig("vquality", applied.log.config.vquality);
            if (applied.log.config.videoSeconds) updateConfig("videoSeconds", applied.log.config.videoSeconds);
            if (applied.log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", applied.log.config.videoGenerateAudio);
            if (applied.log.config.videoWatermark) updateConfig("videoWatermark", applied.log.config.videoWatermark);
            if (applied.log.config.videoMode) updateConfig("videoMode", applied.log.config.videoMode);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成记录读取失败");
        }
    };

    const updateGenerationConfig: UpdateAiConfig = (key, value) => {
        updateConfig(key, value);
        if (!["vquality", "size", "videoSeconds", "videoGenerateAudio", "videoWatermark", "videoMode", "videoModel"].includes(key)) return;
        const preferences = { ...preferencesRef.current, [key === "size" ? "videoSize" : key]: value };
        preferencesRef.current = preferences;
        void updateGenerationPreferences(preferences).catch(() => undefined);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel logs={logs} variant="video" selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={deleteSelectedLogs} onPreviewLog={previewGenerationLog} />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div className="flex items-start justify-between gap-3">
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("videoWorkbench.title")}</h1>
                            <div className="flex shrink-0 gap-2 lg:hidden">
                                <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                    {t("workbench.logs")}
                                </Button>
                                <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.settings")}
                                </Button>
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
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("videoWorkbench.promptPlaceholder")} />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("videoWorkbench.references")}</span>
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
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={handleReferenceDragEnter}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{index + 1}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label={t("videoWorkbench.removeImage")}>
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{referenceDragTarget ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noImages")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {normalizeVideoResolutionValue(effectiveConfig.vquality)}p · {videoSizeLabel(effectiveConfig.size)} · {normalizeVideoSeconds(effectiveConfig.videoSeconds)}s · {videoModeLabel(effectiveConfig.videoMode)}
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
                            <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                            {activeBatchIds.length || generating ? <Tag className="m-0 px-2 py-1">{t("workbench.generating")}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4">
                                {results.map((result) => (result.status === "success" && result.video ? <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} /> : result.status === "failed" ? <FailedVideoCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => void retryResult(result.id)} /> : <PendingVideoCard key={result.id} />))}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <VideoIcon className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("videoWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*,audio/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel logs={logs} variant="video" selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={deleteSelectedLogs} onPreviewLog={previewGenerationLog} />
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
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => message.warning("平台模型渠道未就绪，请联系管理员配置渠道")} />
            </label>
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="w-full space-y-4" />
        </div>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <video src={video.url} controls className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        {t("common.download")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
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
    const config = videoLogConfig(parameters, batch.modelId);

    return {
        ...summaryLogBase(batch, models),
        config,
        references: [],
        referenceMediaIds: [],
        durationMs: 0,
        size: config.size,
        resolution: config.vquality,
        seconds: config.videoSeconds,
        status: batch.summary.activeCount > 0 ? "pending" : batch.summary.succeededCount > 0 ? "success" : "failed",
        results: [],
    };
}

function videoLogConfig(parameters: Record<string, unknown>, modelId: string): GenerationLog["config"] {
    return {
        model: modelId,
        videoModel: modelId,
        size: String(parameters.size || ""),
        vquality: normalizeVideoResolutionValue(String(parameters.resolution_name || parameters.vquality || "")),
        videoSeconds: normalizeVideoSeconds(String(parameters.seconds || parameters.videoSeconds || "")),
        videoGenerateAudio: String(boolConfig(parameters.generate_audio ?? parameters.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(parameters.watermark ?? parameters.videoWatermark, false)),
        videoMode: parameters.mode === "reference" || parameters.videoMode === "reference" ? "reference" : "frames",
    };
}

function detailToLog(detail: GenerationBatchDetail, models: PublicModel[]): { log: GenerationLog; results: GenerationResult[] } {
    const parameters = detail.batch.parameters || {};
    const results = detail.tasks.map(taskToResult);
    const successResult = results.find((r) => r.status === "success" && r.video);
    const active = detail.tasks.some(isActiveGenerationTask);
    const model = models.find((item) => item.id === detail.batch.modelId);
    const config = videoLogConfig(parameters, detail.batch.modelId);
    const successCount = detail.tasks.filter((t) => t.status === "succeeded").length;
    const status = active ? "pending" : successCount ? "success" : "failed";

    const references: ReferenceImage[] = detail.referenceMediaIds.map((mediaId, index) => ({
        id: mediaId,
        name: `reference-${index + 1}`,
        type: "image",
        dataUrl: `/api/media/${mediaId}`,
        storageKey: mediaId,
    }));

    const log: GenerationLog = {
        id: detail.batch.id,
        createdAt: new Date(detail.batch.createdAt).getTime(),
        title: detail.batch.prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt: detail.batch.prompt,
        time: new Date(detail.batch.createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: detail.tasks[0]?.modelDisplayName || detail.tasks[0]?.modelName || model?.displayName || model?.name || detail.batch.modelId,
        modelId: detail.batch.modelId,
        config,
        references,
        referenceMediaIds: detail.referenceMediaIds,
        durationMs: Math.max(0, ...detail.tasks.map(generationTaskDuration)),
        size: config.size,
        resolution: config.vquality,
        seconds: config.videoSeconds,
        status,
        video: successResult?.video,
        results,
        error: detail.tasks.find((t) => t.errorMessage)?.errorMessage ?? undefined,
    };

    return { log, results };
}

function taskToResult(task: GenerationTask): GenerationResult {
    if (task.status === "succeeded" && (task.output || task.image)) {
        const media = task.output || task.image;
        const mediaId = media?.mediaId;
        const url = media?.url || (mediaId ? `/api/media/${mediaId}` : "");
        const video: GeneratedVideo = {
            id: task.id,
            url,
            storageKey: mediaId,
            durationMs: generationTaskDuration(task),
            width: media?.width || 0,
            height: media?.height || 0,
            bytes: media?.bytes || 0,
            mimeType: media && "mimeType" in media ? (media.mimeType as string) : "video/mp4",
        };
        return { id: task.id, status: "success", video };
    }
    if (task.status === "failed" || task.status === "canceled") {
        return { id: task.id, status: "failed", error: task.errorMessage || task.errorCode || i18n.t("workbench.generationFailed") };
    }
    return { id: task.id, status: task.status === "reviewing" ? "reviewing" : task.status === "running" ? "running" : "queued" };
}

function normalizeVideoSeconds(value: string) {
    if (String(value).trim() === "-1") return "-1";
    return clampVideoSeconds(value);
}
