import { BookOpen, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Drawer, Empty, Image, Input, Tag, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { LogPanel } from "@/components/generation/log-panel";
import { ReferenceOrderButtons } from "@/components/generation/reference-order-buttons";
import { ReferenceUploadFeedback } from "@/components/generation/reference-upload-feedback";
import { GenerationFailureCard } from "@/components/generation/generation-failure-card";
import { workbenchExamples } from "@/constant/creation-scenes";
import { canvasThemes } from "@/lib/canvas-theme";
import { fileBaseName, fileExtension, moveListItem, summaryLogBase, type GenerationLog } from "@/lib/generation-log";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { resolveCreationDraftModel } from "@/lib/creation-draft-model";
import { createZip } from "@/lib/zip";
import { modelOptionName, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { createGenerationBatch, getGenerationBatch, retryGenerationTask, updateGenerationPreferences, type GenerationBatchDetail, type GenerationBatchListItem, type GenerationTask, type PublicModel } from "@/services/api/generation";
import { platformImageParameters } from "@/services/api/image";
import { ensurePlatformMedia, selectedPlatformModel } from "@/services/api/tasks";
import { mediaId } from "@/services/api/media";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useGenerationBatches, useWorkbenchBootstrap, isActiveGenerationTask, generationTaskDuration } from "@/hooks/use-generation-batches";
import { useGenerationQuote } from "@/hooks/use-generation-quote";
import { useConfirmInputReplace } from "@/hooks/use-confirm-input-replace";
import { useAddToCanvas } from "@/hooks/use-add-to-canvas";
import { useWorkbenchInput, type WorkbenchInput } from "@/hooks/use-workbench-input";
import { useWorkbenchReferenceUploads } from "@/hooks/use-workbench-reference-uploads";
import { useWorkbenchView } from "@/hooks/use-workbench-view";
import { getWorkbenchDraft } from "@/stores/use-workbench-draft-store";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import i18n from "@/i18n";
import { IMAGE_WORKBENCH_MAX_COUNT, readImageDraftSettings } from "./creation-draft";

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
    const confirmReplace = useConfirmInputReplace();
    const savedInput = useRef(getWorkbenchDraft<WorkbenchInput>("image")).current;
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const { t } = useTranslation();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const targetBatchId = searchParams.get("batch") || "";
    const reuseBatch = searchParams.get("reuse") === "1";
    const workbenchView = useWorkbenchView(targetBatchId && !reuseBatch ? "results" : "create");
    const viewBatchRef = useRef(targetBatchId);
    const handledReuse = useRef("");
    const targetBatchRef = useRef(targetBatchId);
    targetBatchRef.current = targetBatchId;
    const initialBatchRef = useRef<string | null>(null);
    const dismissedBatchRef = useRef<string | null>(null);
    const batchRequestRef = useRef(0);
    const mountedRef = useRef(false);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; ++batchRequestRef.current; };
    }, []);
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const draft = useCreationDraftStore((state) => state.draft);
    const pendingDraft = Boolean(draft?.capability === "image" && draft.sessionVersion === sessionVersion);
    const clearDraft = useCreationDraftStore((state) => state.clearDraft);
    const appliedDraftRef = useRef("");
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
    const [modelId, setModelId] = useState(savedInput?.model || remixState?.modelId || "");
    const [ambiguousDraftModel, setAmbiguousDraftModel] = useState(false);
    const [prompt, setPrompt] = useState(savedInput?.prompt || remixState?.prompt || "");
    const referenceUploads = useWorkbenchReferenceUploads({ initialReferences: savedInput?.references || [], sessionVersion, captureInputScope, supportsType: (type) => SUPPORTED_IMAGE_TYPES.has(type), unsupportedMessage: "仅支持 PNG、JPEG、WebP 图片，请转换格式后重新上传" });
    const { references, setReferences, addFiles: addReferences, addClipboard: addReferencesFromClipboard } = referenceUploads;
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
            const initialModel = savedInput?.model || remixState?.modelId || preferredModelId;
            setModelId(initialModel);
            if (initialModel) updateConfig("imageModel", initialModel);
            for (const key of ["quality", "size", "count", "background"] as const) {
                const value = savedInput?.settings[key] ?? preferences[key];
                if (typeof value === "string") updateConfig(key, value);
            }
        },
        resolveInitialBatchId: (batches) => {
            initialBatchRef.current = batches.find((batch) => batch.summary.activeCount > 0)?.id || null;
            return null;
        },
        onBatch: (batch) => batch.summary.thumbnailMediaIds.forEach((id) => void ensureImagePreview(id)),
    });

    const model = modelId || effectiveConfig.imageModel || effectiveConfig.model;
    const generationCount = Math.max(1, Math.min(IMAGE_WORKBENCH_MAX_COUNT, Number(config.count) || 1));
    const quoteModelId = effectiveConfig.platformModels.find((item) => item.name === modelOptionName(model) && item.capability === "image")?.name || "";
    let parameters: Record<string, unknown> = {};
    let parameterError = "";
    try { parameters = platformImageParameters(effectiveConfig); }
    catch (error) { parameterError = error instanceof Error ? error.message : "图片参数不可用"; }
    const referencesReady = !referenceUploads.hasPending() && !referenceUploads.hasFailures();
    const quote = useGenerationQuote({ modelId: quoteModelId, count: generationCount, content: prompt, parameters, attachmentMediaIds: references.flatMap((item) => item.storageKey ? [mediaId(item.storageKey)] : []) }, initialized && !parameterError && referencesReady);
    const disabledReason = generating ? "正在提交本次生成，请稍候" : referenceUploads.hasPending() ? "参考素材正在准备或上传，请完成后再生成" : referenceUploads.hasFailures() ? "请重试或移除失败的参考素材后再生成" : !prompt.trim() ? "请先填写提示词" : ambiguousDraftModel ? "请明确选择同名模型配置" : !quoteModelId ? "请选择可用模型" : parameterError || quote.error?.message || (!quote.ready ? "正在获取本次费用，请稍候" : "");
    const canGenerate = !disabledReason;
    const failedResultIndexes = results.flatMap((item, index) => (item.status === "failed" ? [index] : []));
    const successImages = results.flatMap((item) => (item.status === "success" && item.image ? [item.image] : []));

    const inputDraft = useWorkbenchInput("image", { prompt, references, model, config: effectiveConfig }, initialized, sessionVersion);

    const loadBatchRef = useRef<(id: string, restoreInput: boolean) => Promise<void>>(async () => undefined);
    loadBatchRef.current = async (id, restoreInput) => {
        const request = ++batchRequestRef.current;
        referenceUploads.clearUploads();
        const version = useUserStore.getState().sessionVersion;
        try {
            const detail = await getGenerationBatch(id);
            if (request !== batchRequestRef.current || useUserStore.getState().sessionVersion !== version) return;
            if (detail.batch.capability && detail.batch.capability !== "image") throw new Error("该任务不是图片生成任务");
            const applied = applyDetail(detail);
            setPreviewLog(applied.log);
            setResults(applied.results);
            if (!restoreInput) return;
            handledReuse.current = id;
            confirmReplace(inputDraft.dirty, () => {
                if (!mountedRef.current || request !== batchRequestRef.current || useUserStore.getState().sessionVersion !== version) return;
                ++batchRequestRef.current;
                referenceUploads.clearUploads();
                workbenchView.selectView("create");
                setPrompt(applied.log.prompt);
                setReferences(applied.log.references);
                setModelId(detail.batch.modelId);
                setAmbiguousDraftModel(false);
                updateConfig("imageModel", detail.batch.modelId);
                updateConfig("quality", applied.log.config.quality);
                updateConfig("size", applied.log.config.size);
                updateConfig("count", applied.log.config.count);
                updateConfig("background", applied.log.config.background);
            });
        } catch (error) {
            if (request === batchRequestRef.current && useUserStore.getState().sessionVersion === version) message.error(error instanceof Error ? error.message : "生成记录读取失败");
        }
    };

    useEffect(() => {
        if (!initialized || generating || !draft || draft.capability !== "image" || draft.sessionVersion !== sessionVersion || appliedDraftRef.current === draft.id) return;
        appliedDraftRef.current = draft.id;
        confirmReplace(inputDraft.dirty, () => {
            if (useCreationDraftStore.getState().draft?.id !== draft.id) return;
            const previousBatch = targetBatchRef.current;
            dismissedBatchRef.current = previousBatch || null;
            targetBatchRef.current = "";
            ++batchRequestRef.current;
            referenceUploads.clearUploads();
            initialBatchRef.current = null;
            workbenchView.selectView("create");
            setPrompt(draft.prompt);
            setReferences(draft.references || []);
            setResults([]);
            setPreviewLog(null);
            if (draft.modelId || draft.modelName) {
                const { model: selected, ambiguous } = resolveCreationDraftModel(modelsRef.current, draft);
                setAmbiguousDraftModel(ambiguous);
                const value = selected?.id || draft.modelId || draft.modelName || "";
                setModelId(value);
                updateConfig("imageModel", value);
                if (!selected) message.warning(ambiguous ? `草稿名称「${draft.modelName}」对应多个模型配置，请明确选择` : `草稿指定的模型「${draft.modelName || draft.modelId}」当前不可用，请重新选择`);
            }
            const applied = readImageDraftSettings(draft.settings, useConfigStore.getState().config);
            for (const [key, value] of Object.entries(applied.settings)) updateConfig(key as "size" | "quality" | "count" | "background", value);
            if (applied.warnings.length) message.warning(`草稿中的${applied.warnings.join("、")}无法使用，已保留当前设置`);
            if (previousBatch) {
                setSearchParams((current) => { current.delete("batch"); current.delete("reuse"); return current; }, { replace: true });
            }
            clearDraft(draft.id);
        }, () => clearDraft(draft.id));
    }, [initialized, generating, draft, sessionVersion, updateConfig, clearDraft, message, setSearchParams]);

    useEffect(() => {
        if (!initialized || pendingDraft || targetBatchId !== targetBatchRef.current || targetBatchId && targetBatchId === dismissedBatchRef.current) return;
        dismissedBatchRef.current = null;
        if (!reuseBatch) handledReuse.current = "";
        const id = targetBatchId || initialBatchRef.current;
        if (targetBatchId !== viewBatchRef.current) {
            viewBatchRef.current = targetBatchId;
            if (targetBatchId) workbenchView.selectView(reuseBatch ? "create" : "results");
        }
        if (id) {
            const shouldReuse = reuseBatch && handledReuse.current !== id;
            void loadBatchRef.current(id, shouldReuse);
        }
        return () => { ++batchRequestRef.current; referenceUploads.clearUploads(); };
    }, [initialized, targetBatchId, sessionVersion, pendingDraft, reuseBatch]);

    function captureInputScope() {
        const version = useUserStore.getState().sessionVersion;
        const request = batchRequestRef.current;
        const target = targetBatchRef.current;
        return () => {
            assertCurrentSession(version);
            if (!mountedRef.current || request !== batchRequestRef.current || target !== targetBatchRef.current) throw new DOMException("当前创作输入已改变", "AbortError");
        };
    }

    const generate = async () => {
        if (generatingRef.current) return;
        if (referenceUploads.hasPending() || referenceUploads.hasFailures()) {
            message.warning("请等待参考素材上传完成，并重试或移除失败项后再生成");
            const taskId = agentTaskIdRef.current;
            if (taskId) updateAgentTask(taskId, { status: "failed", error: "参考素材尚未准备完成" });
            agentTaskIdRef.current = undefined;
            return;
        }
        generatingRef.current = true;
        setGenerating(true);
        const sessionVersion = useUserStore.getState().sessionVersion;
        const sourceBatchId = targetBatchRef.current;
        const viewRequest = ++batchRequestRef.current;
        const showSubmittedResults = workbenchView.captureResultView();
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const submittedFingerprint = inputDraft.fingerprint;
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
            const referenceMediaIds = await Promise.all(references.map((item) => ensurePlatformMedia(item)));
            const targetModelId = selectedPlatformModel(modelsRef.current, currentModel, "image");
            assertCurrentSession(sessionVersion);
            if (!mountedRef.current || viewRequest !== batchRequestRef.current || targetBatchRef.current !== sourceBatchId) return;
            const created = await createGenerationBatch({ modelId: targetModelId, prompt: text, count: generationCount, parameters: platformImageParameters(effectiveConfig), referenceMediaIds });
            assertCurrentSession(sessionVersion);
            inputDraft.submitted(submittedFingerprint);
            const applied = applyDetail({ ...created, referenceMediaIds, referenceMedia: references.map((item, index) => ({ mediaId: referenceMediaIds[index], mimeType: item.type, originalName: item.name })) });
            if (mountedRef.current && viewRequest === batchRequestRef.current && targetBatchRef.current === sourceBatchId) {
                setPreviewLog(applied.log);
                setResults(applied.results);
                showSubmittedResults();
                viewBatchRef.current = created.batch.id;
                setSearchParams((current) => { current.set("batch", created.batch.id); current.delete("reuse"); return current; }, { replace: true });
            }
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
        referenceUploads.addReference({ id: nanoid(), name: `生成图片-${index + 1}.png`, type: image.mimeType || "image/png", dataUrl: image.dataUrl, storageKey: image.storageKey });
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
                metadata: { source: "image-page", prompt: previewLog?.prompt || prompt },
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
        const assertInput = captureInputScope();
        try {
            assertInput();
            if (payload.kind === "text") {
                confirmReplace(inputDraft.dirty, () => { ++batchRequestRef.current; referenceUploads.clearUploads(); setPrompt(payload.content); });
            } else if (payload.kind === "image") {
                const existingId = payload.storageKey ? mediaId(payload.storageKey) : "";
                if (existingId) {
                    referenceUploads.addReference({ id: nanoid(), name: payload.title, type: "image", dataUrl: `/api/media/${existingId}`, storageKey: existingId });
                } else {
                    referenceUploads.addSources([{ name: payload.title, type: "image/png", prepare: async () => (await fetch(payload.dataUrl)).blob() }], assertInput);
                }
            } else {
                message.warning(t("imageWorkbench.unsupportedAsset"));
            }
            setAssetPickerOpen(false);
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError" || useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.error(error instanceof Error ? error.message : "素材读取失败");
        }
    };

    const clearViewedBatch = () => {
        const previousBatch = targetBatchRef.current;
        dismissedBatchRef.current = previousBatch || null;
        targetBatchRef.current = "";
        ++batchRequestRef.current;
        referenceUploads.clearUploads();
        initialBatchRef.current = null;
        if (previousBatch) setSearchParams((current) => { current.delete("batch"); current.delete("reuse"); return current; }, { replace: true });
        setResults([]);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const createSession = () => confirmReplace(inputDraft.dirty, () => {
        clearViewedBatch();
        workbenchView.selectView("create");
        setLogsOpen(false);
        setPrompt("");
        setReferences([]);
    });

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
                    if (previewLog && deletedIds.includes(previewLog.id)) clearViewedBatch();
                }
            },
        });
    };

    const previewGenerationLog = (log: GenerationLog) => {
        dismissedBatchRef.current = null;
        setLogsOpen(false);
        workbenchView.selectView("results");
        if (targetBatchId === log.id) void loadBatchRef.current(log.id, false);
        else setSearchParams((current) => { current.set("batch", log.id); current.delete("reuse"); handledReuse.current = ""; return current; });
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
        workbenchView.markInteraction();
        updateConfig(key, value);
        if (key === "imageModel" && typeof value === "string") {
            setModelId(value);
            setAmbiguousDraftModel(false);
        }
        if (!["quality", "size", "count", "background", "imageModel"].includes(key)) return;
        const preferences = { [key === "imageModel" ? "imageModelId" : key]: key === "imageModel" && typeof value === "string" ? modelOptionName(value) : value };
        preferencesRef.current = { ...preferencesRef.current, ...preferences };
        void updateGenerationPreferences(preferences).catch(() => undefined);
    };

    return (
        <div className="@container/workbench flex h-full min-w-0 flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <nav className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2 @min-[1024px]/workbench:hidden" aria-label="工作台视图">
                <Button type={workbenchView.view === "create" ? "primary" : "text"} aria-pressed={workbenchView.view === "create"} onClick={() => workbenchView.selectView("create")}>创作</Button>
                <Button type={workbenchView.view === "results" ? "primary" : "text"} aria-pressed={workbenchView.view === "results"} onClick={() => workbenchView.selectView("results")}>结果</Button>
                <Button type="text" className="!ml-auto" icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>{t("workbench.logs")}</Button>
            </nav>
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 @min-[1024px]/workbench:grid-cols-[300px_minmax(0,1fr)] @min-[1280px]/workbench:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 @min-[1024px]/workbench:block">
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

                <section className="grid min-h-0 min-w-0 gap-3 overflow-hidden @min-[1024px]/workbench:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] @min-[1280px]/workbench:grid-cols-[420px_minmax(0,1fr)]">
                    <div className={`min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 ${workbenchView.view === "create" ? "flex" : "hidden"} @min-[1024px]/workbench:flex`} aria-label="创作输入">
                        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4" onPointerDownCapture={workbenchView.markInteraction} onChangeCapture={workbenchView.markInteraction} onKeyDownCapture={workbenchView.markInteraction}>
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("imageWorkbench.title")}</h1>

                            <p className="mt-2 text-xs leading-5 text-muted-foreground">输入在当前会话跨页面保留，刷新页面后清空。</p>
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
                                                    className="absolute right-1 top-1 flex size-6 items-center justify-center rounded bg-black/60 text-white [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"
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

                                <ReferenceUploadFeedback uploads={referenceUploads.uploads} onRetry={referenceUploads.retry} onRemove={referenceUploads.remove} />

                                <div className="space-y-3">
                                    <label className="block min-w-0"><span className="mb-2 block text-sm font-medium">{t("workbench.model")}</span><ModelPicker config={effectiveConfig} value={model} onChange={(value) => updateGenerationConfig("imageModel", value)} capability="image" fullWidth unavailableLabel={ambiguousDraftModel ? "请明确选择模型" : undefined} onMissingConfig={() => message.warning(t("imageWorkbench.noModelHint"))} /></label>
                                    <Button type="text" className="!h-auto !max-w-full !justify-start !px-0 !py-1.5" icon={<SlidersHorizontal className="size-4" />} title={`参数 · ${imageQualityLabel(effectiveConfig.quality)}`} onClick={() => setSettingsOpen(true)}>
                                        <span className="truncate text-sm">{imageSizeLabel(effectiveConfig.size)} · {t("canvas.controls.images", { count: generationCount })}</span>
                                    </Button>
                                </div>
                            </div>
                        </div>
                        <div className="shrink-0 border-t border-border bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 text-xs leading-5 text-muted-foreground" aria-live="polite">{!referencesReady ? "素材就绪后计算费用" : quote.quote ? <>预计冻结 <span className="font-semibold tabular-nums text-foreground">¥{quote.quote.estimatedHold}</span></> : quote.isFetching ? "正在获取本次费用…" : quote.error ? "本次费用获取失败" : ambiguousDraftModel ? "请明确选择同名模型配置" : !quoteModelId ? "请选择可用模型" : "输入提示词后查看费用"}</div>
                                <Button type="primary" size="large" className="shrink-0" icon={<Sparkles className="size-4" />} loading={generating} disabled={!canGenerate || generating} title={disabledReason || "开始生成"} onClick={() => void generate()}>{t("workbench.generate")}</Button>
                            </div>
                            {disabledReason ? <p className="mt-2 text-xs leading-5 text-muted-foreground" role="status">{disabledReason}</p> : null}
                            {referencesReady && quote.error ? <Button type="text" size="small" className="!px-0" loading={quote.isFetching} onClick={() => void quote.refetch()}>重试报价</Button> : null}
                            {referencesReady && quote.quote ? <p className="mt-1 text-xs leading-5 text-muted-foreground">冻结金额不是最终扣费，最终结算以账户账单为准。</p> : null}
                        </div>
                    </div>

                    <div className={`thin-scrollbar min-h-0 min-w-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 ${workbenchView.view === "results" ? "block" : "hidden"} @min-[1024px]/workbench:block @min-[1024px]/workbench:p-5`} aria-label="生成结果">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                                {previewLog ? <Button type="text" size="small" disabled={generating} onClick={() => void loadBatchRef.current(previewLog.id, true)}>用此批次再创作</Button> : null}
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
                        <Button type="text" className="!mb-3 !px-0 @min-[1024px]/workbench:!hidden" onClick={() => workbenchView.selectView("create")}>继续调整</Button>
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 @min-[1536px]/workbench:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "reviewing" || result.status === "queued" || result.status === "running" ? (
                                        <PendingImageCard key={result.id} status={result.status} />
                                    ) : (
                                        <GenerationFailureCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => void retryResults([index])} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 @min-[1024px]/workbench:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} />
                                <p className="mb-3 text-xs text-muted-foreground">选一个示例开始，仅填入内容，不会自动生成</p>
                                <div className="flex flex-wrap justify-center gap-2 px-4">
                                    {workbenchExamples.filter((item) => item.example.capability === "image").map((item) => <Button key={item.id} size="small" onClick={() => useCreationDraftStore.getState().setDraft(item.example)}>{item.title}</Button>)}
                                </div>
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
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateGenerationConfig} unavailableLabel={ambiguousDraftModel ? "请明确选择模型" : undefined} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={(value) => confirmReplace(inputDraft.dirty, () => { ++batchRequestRef.current; referenceUploads.clearUploads(); setPrompt(value); })} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, unavailableLabel }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; unavailableLabel?: string }) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <div className="space-y-4">
            <label className="block min-w-0">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth unavailableLabel={unavailableLabel} onMissingConfig={() => message.warning(t("imageWorkbench.noModelHint"))} />
            </label>
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="w-full space-y-4" maxCount={IMAGE_WORKBENCH_MAX_COUNT} />
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
    const addToCanvas = useAddToCanvas();
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
                <div className="grid min-w-0 grid-cols-2 gap-2">
                    <Button type="text" className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => addToCanvas([{ kind: "image", dataUrl: image.dataUrl, storageKey: image.storageKey, title: `生成图片 ${index + 1}` }])}>加入画布</Button>
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


function summaryToLog(batch: GenerationBatchListItem, models: PublicModel[]): GenerationLog {
    const parameters = batch.parameters || {};
    return {
        ...summaryLogBase(batch, models),
        config: { model: batch.modelId, imageModel: batch.modelId, quality: String(parameters.quality || "auto"), size: String(parameters.size || "auto"), count: String(batch.requestedCount), background: String(parameters.background || "") },
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
        return { id: task.id, status: "success", image: { id: task.id, dataUrl: task.image.url, storageKey: task.image.mediaId, durationMs: generationTaskDuration(task), width: task.image.width || 0, height: task.image.height || 0, bytes: task.image.bytes || 0, mimeType: task.image.mimeType } };
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
        config: { model: detail.batch.modelId, imageModel: detail.batch.modelId, quality: String(parameters.quality || "auto"), size: String(parameters.size || "auto"), count: String(detail.batch.requestedCount), background: String(parameters.background || "") },
        references: detail.referenceMedia.map((media, index) => ({ id: media.mediaId, name: media.originalName || `reference-${index + 1}`, type: media.mimeType, dataUrl: `/api/media/${media.mediaId}`, storageKey: media.mediaId })),
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


