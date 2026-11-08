import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as router from "react-router-dom";
import * as icons from "lucide-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GenerationBatchDetail, PublicModel } from "@/services/api/generation";
import { loadModule, readSource } from "./support/source-loader";
import { nanoid } from "nanoid";
import { workbenchExamples } from "@/constant/creation-scenes";
import { useWorkbenchView } from "@/hooks/use-workbench-view";

const api = vi.hoisted(() => ({ confirm: vi.fn(), getBatch: vi.fn(), create: vi.fn(), ensure: vi.fn(), upload: vi.fn(), warning: vi.fn(), error: vi.fn(), quote: vi.fn(), refetchQuote: vi.fn(), retry: vi.fn(), watch: vi.fn(), recover: vi.fn(), readInput: vi.fn(), writeInput: vi.fn(), historyPending: false, finishHistory: () => {}, storedInputs: new Map<string, unknown>(), subscriptionErrors: {} as Record<string, string> }));
vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    const useUserStore = create(() => ({ sessionVersion: 1, user: { id: "test-user" } }));
    return { useUserStore, assertCurrentSession: (version: number) => { if (useUserStore.getState().sessionVersion !== version) throw new DOMException("会话已变更", "AbortError"); } };
});
vi.mock("@/services/api/generation", () => ({ getGenerationPreferences: async () => ({}), getGenerationBatch: api.getBatch, createGenerationBatch: api.create, uploadGenerationMedia: vi.fn(), retryGenerationTask: vi.fn(), updateGenerationPreferences: vi.fn() }));
vi.mock("@/stores/workbench-input-storage", () => ({ readWorkbenchInput: api.readInput, writeWorkbenchInput: api.writeInput }));

import { useWorkbenchInput, workbenchSettingKeys } from "@/hooks/use-workbench-input";
import { clearWorkbenchDraft, getWorkbenchDraft, saveWorkbenchDraft } from "@/stores/use-workbench-draft-store";
import { defaultConfig, modelOptionName, useConfigStore, boolConfig } from "@/stores/use-config-store";
import { useUserStore, assertCurrentSession } from "@/stores/use-user-store";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import { resolveCreationDraftModel } from "@/lib/creation-draft-model";
import { readImageDraftSettings, IMAGE_WORKBENCH_MAX_COUNT } from "@/pages/image/creation-draft";
import { readVideoDraftSettings } from "@/pages/video/creation-draft";
import { imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { normalizeVideoResolutionValue, videoModeLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { platformImageParameters } from "@/services/api/image";
import { videoGenerationParameters } from "@/services/api/video";
import { clampVideoSeconds } from "@/lib/media-size";
import { moveListItem, summaryLogBase } from "@/lib/generation-log";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";

const models: PublicModel[] = ["image", "video"].flatMap((capability) => [1, 2].map((index) => ({ id: `${capability}-${index}`, name: `${capability}-upstream-${index}`, displayName: `${capability} 模型 ${index}`, capability: capability as "image" | "video", price: "0.1", sortOrder: index, description: null })));
const t = (key: string) => key;
const noop = () => undefined;
const children = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const button = ({ children, icon, onClick, disabled }: any) => <button type="button" onClick={onClick} disabled={disabled}>{icon}{children}</button>;
const textarea = ({ value, onChange, placeholder }: any) => <textarea value={value} onChange={onChange} placeholder={placeholder} />;
const image = ({ src, alt }: any) => <img src={src} alt={alt} />;
const empty = Object.assign(({ description }: any) => <div>{description}</div>, { PRESENTED_IMAGE_SIMPLE: "simple" });
const imageStorage = { subscribeImagePreviews: () => noop, getImagePreviewRevision: () => 0, previewUrlFor: () => "", ensureImagePreview: async () => undefined, uploadImage: vi.fn() };
const uploadHook = loadModule(readSource("hooks/use-workbench-reference-uploads.ts"), { navigator, DOMException }, {
    react: React, nanoid: { nanoid }, "@/services/api/generation": { uploadGenerationMedia: api.upload }, "@/services/image-storage": imageStorage,
});
const workbench = { imageCommand: null as any, videoCommand: null as any, clearImageCommand: noop, clearVideoCommand: noop, updateTask: vi.fn() };
const pendingAgents = new Map<string, Set<string>>();
const registeredAgents = new Map<string, string[]>();
class GenerationSubmissionUncertainError extends Error {}

function useBatches(options: any) {
    const [logs, setLogs] = React.useState<any[]>([]);
    const [previewLog, setPreviewLog] = React.useState<any>(null);
    const [results, setResults] = React.useState<any[]>([]);
    const previewLogIdRef = React.useRef("");
    previewLogIdRef.current = previewLog?.id || "";
    const applyDetail = (detail: GenerationBatchDetail) => {
        options.onDetail?.(detail);
        const applied = options.toLog(detail);
        setLogs((current) => [applied.log, ...current.filter((log) => log.id !== applied.log.id)]);
        if (detail.tasks.every((task) => task.status === "succeeded")) registeredAgents.get(detail.batch.id)?.forEach((id) => workbench.updateTask(id, { status: "succeeded" }));
        return applied;
    };
    return { logs, setLogs, activeBatchIds: [], setActiveBatchIds: noop, previewLog, setPreviewLog, previewLogIdRef, results, setResults, applyDetail, watchBatch: api.watch, registerAgentTask: (id: string, agentId: string) => registeredAgents.set(id, [...(registeredAgents.get(id) || []), agentId]), deleteBatches: noop, ensureNotifyPermission: noop, subscriptionErrors: api.subscriptionErrors, retrySubscription: api.recover };
}

function useBootstrap(options: any) {
    const [initialized, setInitialized] = React.useState(false);
    const [historyReady, setHistoryReady] = React.useState(false);
    React.useEffect(() => {
        const available = models.filter((model) => model.capability === options.capability);
        options.modelsRef.current = available;
        options.preferencesRef.current = {};
        options.applyPreferences({}, available);
        api.finishHistory = () => { options.resolveInitialBatchId([{ id: "other-active", summary: { activeCount: 1 } }]); setHistoryReady(true); };
        if (!api.historyPending) api.finishHistory();
        setInitialized(true);
    }, []);
    return { initialized, historyReady, modelsError: "", historyError: "", preferencesError: "", retryModels: noop, retryHistory: noop, retryPreferences: noop };
}

const imports = {
    react: React, "react/jsx-runtime": jsxRuntime, "react-router-dom": router, "lucide-react": icons,
    antd: { Alert: ({ title, description, action }: any) => <div role="alert">{title}{description}{action}</div>, App: { useApp: () => ({ message: { warning: api.warning, error: api.error, success: noop }, modal: { confirm: noop } }) }, Button: button, Drawer: ({ open, children: content }: any) => open ? <div>{content}</div> : null, Empty: empty, Image: image, Input: { TextArea: textarea }, Tag: children, Tooltip: children, Typography: { Text: children } },
    "react-i18next": { useTranslation: () => ({ t }) }, "file-saver": { saveAs: noop }, nanoid: { nanoid: () => "id" },
    "@/i18n": { default: { t, resolvedLanguage: "zh-CN" } },
    "@/components/image-settings-panel": { ImageSettingsPanel: () => null, imageQualityLabel, imageSizeLabel },
    "@/components/video-settings-panel": { VideoSettingsPanel: () => null, normalizeVideoResolutionValue, videoModeLabel, videoSizeLabel },
    "@/components/model-picker": { ModelPicker: ({ value }: any) => <output data-testid="selected-model">{modelOptionName(value)}</output> },
    "@/components/prompts/prompt-select-dialog": { PromptSelectDialog: () => null },
    "@/components/canvas/asset-picker-modal": { AssetPickerModal: () => null },
    "@/components/generation/log-panel": { LogPanel: () => null },
    "@/components/generation/reference-order-buttons": { ReferenceOrderButtons: () => null },
    "@/components/generation/reference-upload-feedback": { ReferenceUploadFeedback: ({ uploads, onRetry }: any) => <>{uploads.filter((item: any) => item.status === "failed").map((item: any) => <div key={item.id}>{item.error}<button onClick={() => onRetry(item.id)}>重试上传 {item.name}</button></div>)}</> },
    "@/components/generation/generation-failure-card": { GenerationFailureCard: ({ onRetry, error }: any) => <div>{error}<button onClick={onRetry}>重试此任务</button></div> },
    "@/constant/creation-scenes": { workbenchExamples },
    "@/hooks/use-workbench-reference-uploads": uploadHook,
    "@/hooks/use-workbench-view": { useWorkbenchView },
    "@/lib/canvas-theme": { canvasThemes }, "@/lib/creation-draft-model": { resolveCreationDraftModel },
    "@/lib/generation-log": { moveListItem, summaryLogBase }, "@/lib/media-size": { clampVideoSeconds },
    "@/lib/image-reference-prompt": { imageReferenceLabel }, "@/lib/zip": { createZip: noop },
    "@/lib/image-utils": { formatBytes: String, formatDuration: String },
    "@/stores/use-config-store": { useConfigStore, defaultConfig, modelOptionName, boolConfig },
    "@/stores/use-theme-store": { useThemeStore: (selector: any) => selector({ theme: "light" }) },
    "@/stores/use-user-store": { useUserStore, assertCurrentSession },
    "@/stores/use-creation-draft-store": { useCreationDraftStore },
    "@/stores/use-asset-store": { useAssetStore: (selector: any) => selector({ addAsset: noop }) },
    "@/stores/use-workbench-agent-store": { useWorkbenchAgentStore: (selector: any) => selector(workbench), getPendingWorkbenchAgentTasks: (key: string) => new Set(pendingAgents.get(key)), setPendingWorkbenchAgentTasks: (key: string, tasks: Set<string>) => pendingAgents.set(key, tasks) },
    "@/services/api/generation": { getGenerationBatch: api.getBatch, createGenerationBatch: api.create, uploadGenerationMedia: api.upload, retryGenerationTask: api.retry, updateGenerationPreferences: noop },
    "@/services/api/workbench-generation": { GenerationSubmissionUncertainError, submitWorkbenchGeneration: async (value: any, assertInput: () => void) => {
        const referenceMediaIds = await Promise.all(value.references.map((item: any) => api.ensure(item)));
        assertInput();
        const created = await api.create(value);
        return { ...created, referenceMediaIds, referenceMedia: value.references.map((item: any, index: number) => ({ mediaId: referenceMediaIds[index], mimeType: item.type, originalName: item.name })) };
    } },
    "@/services/api/image": { platformImageParameters }, "@/services/api/video": { videoGenerationParameters },
    "@/services/api/media": { mediaId: (key: string) => key.replace(/^(?:image|media):/, "") },
    "@/services/api/tasks": { ensurePlatformMedia: api.ensure, selectedPlatformModel: noop },
    "@/services/image-storage": imageStorage,
    "@/hooks/use-workbench-input": { useWorkbenchInput, workbenchSettingKeys },
    "@/stores/use-workbench-draft-store": { getWorkbenchDraft },
    "@/hooks/use-confirm-input-replace": { useConfirmInputReplace: () => (dirty: boolean, yes: () => void, no?: () => void) => { if (dirty) api.confirm(yes, no); else yes(); } },
    "@/hooks/use-add-to-canvas": { useAddToCanvas: () => noop },
    "@/hooks/use-save-to-assets": { useSaveToAssets: () => noop },
    "@/hooks/use-generation-quote": { useGenerationQuote: api.quote },
    "@/hooks/use-generation-batches": { useGenerationBatches: useBatches, useWorkbenchBootstrap: useBootstrap, isActiveGenerationTask: (task: any) => ["queued", "running", "reviewing"].includes(task.status), generationTaskDuration: () => 0 },
};
const context = { window, document, navigator, URL, Blob, File, HTMLInputElement, AbortController, DOMException, Error, setTimeout, clearTimeout };
const ImagePage = loadModule(readSource("pages/image/index.tsx"), context, { ...imports, "./creation-draft": { readImageDraftSettings, IMAGE_WORKBENCH_MAX_COUNT } }).default;
const VideoPage = loadModule(readSource("pages/video/index.tsx"), context, { ...imports, "./creation-draft": { readVideoDraftSettings } }).default;
let navigate: ReturnType<typeof router.useNavigate>;

function Shell() {
    navigate = router.useNavigate();
    const location = router.useLocation();
    return <><output data-testid="location">{location.pathname}{location.search}</output><router.Routes><router.Route path="/image" element={<ImagePage />} /><router.Route path="/video" element={<VideoPage />} /></router.Routes></>;
}
function mount(capability: "image" | "video", batch = "a") { return render(<router.MemoryRouter initialEntries={[`/${capability}?batch=${batch}&reuse=1`]}><Shell /></router.MemoryRouter>); }
function detail(capability: "image" | "video", id: string): GenerationBatchDetail {
    return { batch: { id, capability, canvasProjectId: null, modelId: `${capability}-2`, prompt: `${id} 的提示词`, requestedCount: capability === "image" ? 3 : 1, parameters: capability === "image" ? { size: "2048x2048", quality: "high", background: "transparent" } : { size: "1920x1080", resolution_name: "1080", seconds: "12", mode: "reference" }, createdAt: "2026-01-01T00:00:00Z" }, tasks: [{ id: `${id}-task`, batchId: id, status: "queued", sequence: 1, errorCode: null, errorMessage: null, queuedAt: "2026-01-01T00:00:00Z", startedAt: null, finishedAt: null, modelName: null, modelDisplayName: null }], referenceMediaIds: [`${id}-reference`], referenceMedia: [{ mediaId: `${id}-reference`, mimeType: "image/png", originalName: "reference-1" }] };
}

beforeEach(() => {
    clearWorkbenchDraft("image"); clearWorkbenchDraft("video");
    api.confirm.mockReset().mockImplementation((yes) => yes());
    useUserStore.setState({ sessionVersion: 1 });
    useCreationDraftStore.getState().clearDraft();
    useConfigStore.setState({ config: { ...defaultConfig, platformModels: models.map((model) => ({ ...model, name: model.id, modelName: model.name })), models: models.map((model) => `platform::${model.id}`), model: "platform::image-1", imageModel: "platform::image-1", videoModel: "platform::video-1" } });
    api.getBatch.mockReset(); api.create.mockReset(); api.ensure.mockReset(); api.upload.mockReset(); api.error.mockReset(); api.warning.mockReset();
    api.storedInputs.clear();
    api.historyPending = false; api.finishHistory = noop;
    api.readInput.mockReset().mockImplementation(async (key) => api.storedInputs.get(key) || null);
    api.writeInput.mockReset().mockImplementation(async (key, value, _session, assertInput) => { assertInput(); api.storedInputs.set(key, value); });
    api.refetchQuote.mockReset();
    api.retry.mockReset(); api.watch.mockReset(); api.recover.mockReset(); api.subscriptionErrors = {};
    pendingAgents.clear(); registeredAgents.clear(); workbench.imageCommand = null; workbench.videoCommand = null; workbench.updateTask.mockReset();
    api.quote.mockReset().mockReturnValue({ quote: { estimatedHold: "0.1" }, ready: true, isFetching: false, error: null, refetch: api.refetchQuote });
});
afterEach(cleanup);

test.each(["image", "video"] as const)("%s 重试 A 期间切到 B，恢复订阅仍归 A，B 结果不被改写", async (capability) => {
    api.getBatch.mockImplementation((id) => {
        const batch = detail(capability, id);
        batch.tasks[0].status = "failed";
        batch.tasks[0].errorMessage = `${id} 的任务失败`;
        return Promise.resolve(batch);
    });
    let finish!: (task: GenerationBatchDetail["tasks"][number]) => void;
    api.retry.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount(capability);
    await screen.findByText("a 的任务失败");
    fireEvent.click(screen.getByRole("button", { name: "重试此任务" }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith("a-task"));
    act(() => navigate(`/${capability}?batch=b`));
    await screen.findByText("b 的任务失败");
    await act(async () => finish({ ...detail(capability, "a").tasks[0], status: "queued" }));
    expect(api.watch).toHaveBeenCalledExactlyOnceWith("a");
    expect(screen.getByText("b 的任务失败")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(`/${capability}?batch=b`);
});

test.each(["image", "video"] as const)("%s 状态中断显示恢复入口，恢复不会重新生成", async (capability) => {
    api.subscriptionErrors = { a: "无法读取最新任务状态" };
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    mount(capability);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取最新任务状态");
    fireEvent.click(screen.getByRole("button", { name: "恢复状态更新" }));
    expect(api.recover).toHaveBeenCalledExactlyOnceWith("a");
    expect(api.create).not.toHaveBeenCalled();
    expect(api.retry).not.toHaveBeenCalled();
});

test.each(["image", "video"] as const)("%s 提交准备期间修改输入，旧准备不发出请求", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    let finish!: (id: string) => void;
    api.ensure.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.click(screen.getByRole("button", { name: "workbench.generate" }));
    await waitFor(() => expect(api.ensure).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新的输入" } });
    await act(async () => finish("prepared"));
    expect(api.create).not.toHaveBeenCalled();
    expect(api.error).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("新的输入");
});

test.each(["image", "video"] as const)("%s 提交回包迟到时保留新加入的上传", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    api.ensure.mockResolvedValue("old-reference");
    let accepted!: (value: unknown) => void;
    let uploaded!: (value: unknown) => void;
    api.create.mockImplementation(() => new Promise((resolve) => { accepted = resolve; }));
    api.upload.mockImplementation(() => new Promise((resolve) => { uploaded = resolve; }));
    const view = mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.click(screen.getByRole("button", { name: "workbench.generate" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["image"], "下一次参考.png", { type: "image/png" })] } });
    await waitFor(() => expect(api.upload).toHaveBeenCalledOnce());
    const created = detail(capability, "created");
    await act(async () => accepted({ batch: created.batch, tasks: created.tasks }));
    expect(screen.getByTestId("location")).toHaveTextContent(`/${capability}?batch=a`);
    await act(async () => uploaded({ id: "next-reference", url: "/api/media/next-reference", mimeType: "image/png" }));
    expect(screen.getByAltText("下一次参考.png")).toBeInTheDocument();
});

test.each(["image", "video"] as const)("%s Agent 提交结果未知后手动恢复，终态立即结算原 Agent 任务", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    api.ensure.mockResolvedValue("reference");
    workbench[capability === "image" ? "imageCommand" : "videoCommand"] = { nonce: 1, run: true, taskId: "agent-1", prompt: "Agent 提示词" };
    api.create.mockRejectedValueOnce(new GenerationSubmissionUncertainError("结果尚未确认"));
    mount(capability);
    await waitFor(() => expect(workbench.updateTask).toHaveBeenCalledWith("agent-1", expect.objectContaining({ status: "running", error: "结果尚未确认" })));
    expect(workbench.updateTask.mock.calls.some(([, patch]) => patch.status === "failed")).toBe(false);
    const created = detail(capability, "recovered");
    created.tasks[0].status = "succeeded";
    api.create.mockResolvedValue({ batch: created.batch, tasks: created.tasks });
    fireEvent.click(screen.getByRole("button", { name: "workbench.generate" }));
    await waitFor(() => expect(workbench.updateTask).toHaveBeenLastCalledWith("agent-1", { status: "succeeded" }));
    expect(registeredAgents.get("recovered")).toContain("agent-1");
});

test.each(["image", "video"] as const)("%s 提交批次后立即展示结果，不因缺少参考详情报错", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    api.ensure.mockResolvedValue("uploaded-reference");
    const created = detail(capability, "created");
    api.create.mockResolvedValue({ batch: created.batch, tasks: created.tasks });
    mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.click(screen.getByRole("button", { name: "workbench.generate" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/${capability}?batch=created`));
    expect(api.error).not.toHaveBeenCalled();
    expect(screen.getByLabelText("生成结果")).not.toHaveClass("hidden");
});

test.each(["image", "video"] as const)("%s 提交失败保留创作视图与输入", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    api.ensure.mockResolvedValue("uploaded-reference");
    api.create.mockRejectedValue(new Error("提交失败"));
    mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.click(screen.getByRole("button", { name: "workbench.generate" }));
    await waitFor(() => expect(api.error).toHaveBeenCalled());
    expect(screen.getByLabelText("创作输入")).not.toHaveClass("hidden");
    expect(screen.getByRole("textbox")).toHaveValue("a 的提示词");
});

test.each(["image", "video"] as const)("%s 提交后继续输入时迟到成功不切走创作视图", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    api.ensure.mockResolvedValue("uploaded-reference");
    let finish!: (value: unknown) => void;
    api.create.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.click(screen.getByRole("button", { name: "workbench.generate" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "下一张的新想法" } });
    const created = detail(capability, "created");
    await act(async () => finish({ batch: created.batch, tasks: created.tasks }));
    expect(screen.getByTestId("location")).toHaveTextContent(`/${capability}?batch=a`);
    expect(screen.getByLabelText("创作输入")).not.toHaveClass("hidden");
    expect(screen.getByRole("textbox")).toHaveValue("下一张的新想法");
});

test.each(["image", "video"] as const)("%s 读取历史期间返回创作，迟到历史不改变视图", async (capability) => {
    let finish!: (value: GenerationBatchDetail) => void;
    api.getBatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    saveWorkbenchDraft(capability, { prompt: "当前草稿", references: [], model: `${capability}-1`, settings: {} }, 1);
    render(<router.MemoryRouter initialEntries={[`/${capability}?batch=a`]}><Shell /></router.MemoryRouter>);
    await waitFor(() => expect(api.getBatch).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("生成结果")).not.toHaveClass("hidden");
    fireEvent.click(screen.getByRole("button", { name: "创作", exact: true }));
    await act(async () => finish(detail(capability, "a")));
    expect(screen.getByLabelText("创作输入")).not.toHaveClass("hidden");
    expect(screen.getByRole("textbox")).toHaveValue("当前草稿");
});

test.each(["image", "video"] as const)("%s 同页切换批次恢复输入、模型、参数和参考，迟到旧结果不反写", async (capability) => {
    let old!: (value: GenerationBatchDetail) => void;
    let next!: (value: GenerationBatchDetail) => void;
    api.getBatch.mockImplementation((id) => new Promise((resolve) => { if (id === "a") old = resolve; else if (id === "b") next = resolve; }));
    mount(capability);
    await waitFor(() => expect(api.getBatch).toHaveBeenCalledWith("a"));
    expect(api.getBatch).not.toHaveBeenCalledWith("other-active");
    act(() => navigate(`/${capability}?batch=b&reuse=1`));
    await waitFor(() => expect(api.getBatch).toHaveBeenCalledWith("b"));
    await act(async () => next(detail(capability, "b")));
    expect(screen.getByRole("textbox")).toHaveValue("b 的提示词");
    expect(screen.getByTestId("selected-model")).toHaveTextContent(`${capability}-2`);
    expect(screen.getByAltText("reference-1")).toHaveAttribute("src", "/api/media/b-reference");
    expect(useConfigStore.getState().config).toMatchObject(capability === "image" ? { size: "2048x2048", count: "3", background: "transparent" } : { size: "1920x1080", vquality: "1080", videoSeconds: "12", videoMode: "reference" });
    await act(async () => old(detail(capability, "a")));
    expect(screen.getByRole("textbox")).toHaveValue("b 的提示词");
    expect(screen.getByAltText("reference-1")).toHaveAttribute("src", "/api/media/b-reference");
});

test.each(["image", "video"] as const)("%s 初始化同时存在新草稿和旧批次 URL 时不会先读取旧批次", async (capability) => {
    useCreationDraftStore.getState().setDraft({ capability, prompt: "新的创作草稿", modelId: `${capability}-2`, settings: { size: "2048x2048" } });
    mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("新的创作草稿"));
    expect(screen.getByTestId("location")).toHaveTextContent(`/${capability}`);
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("batch="));
    expect(api.getBatch).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(useCreationDraftStore.getState().draft).toBeNull();
});

test.each(["image", "video"] as const)("%s 批次读取期间收到草稿后，旧请求完成也不覆盖新输入或重新读旧 URL", async (capability) => {
    let old!: (value: GenerationBatchDetail) => void;
    api.getBatch.mockImplementation(() => new Promise((resolve) => { old = resolve; }));
    mount(capability);
    await waitFor(() => expect(api.getBatch).toHaveBeenCalledTimes(1));
    act(() => useCreationDraftStore.getState().setDraft({ capability, prompt: "优先使用这个草稿", modelId: `${capability}-2` }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("优先使用这个草稿"));
    await act(async () => old(detail(capability, "a")));
    expect(screen.getByRole("textbox")).toHaveValue("优先使用这个草稿");
    expect(api.getBatch).toHaveBeenCalledTimes(1);
    expect(api.create).not.toHaveBeenCalled();
});

test.each(["image", "video"] as const)("%s 在 A 上传的延迟结果不会把参考追加到同页 B", async (capability) => {
    api.getBatch.mockImplementation((id) => Promise.resolve(detail(capability, id)));
    let finish!: (value: unknown) => void;
    api.upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["image"], "A.png", { type: "image/png" })] } });
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    expect(api.quote.mock.lastCall?.[1]).toBe(false);
    expect(screen.getByText("素材就绪后计算费用")).toBeInTheDocument();
    expect(screen.queryByText("¥0.1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "workbench.generate" })).toBeDisabled();
    act(() => navigate(`/${capability}?batch=b&reuse=1`));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("b 的提示词"));
    await act(async () => finish({ id: "a-upload", url: "/api/media/a-upload", mimeType: "image/png" }));
    expect(screen.getByAltText("reference-1")).toHaveAttribute("src", "/api/media/b-reference");
    expect(screen.queryByAltText("A.png")).not.toBeInTheDocument();
    expect(api.error).not.toHaveBeenCalled();
});

test.each(["image", "video"] as const)("%s 上传失败后不显示遗漏素材的报价", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    api.upload.mockRejectedValue(new Error("上传失败"));
    const view = mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["image"], "A.png", { type: "image/png" })] } });
    await screen.findByText("请重试或移除失败的参考素材后再生成");
    expect(api.quote.mock.lastCall?.[1]).toBe(false);
    expect(screen.queryByText("¥0.1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "workbench.generate" })).toBeDisabled();
});

test.each(["image", "video"] as const)("%s 报价失败可手动重试，不触发生成", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    api.quote.mockReturnValue({ ready: false, isFetching: false, error: new Error("报价服务暂不可用"), refetch: api.refetchQuote });
    mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    fireEvent.click(screen.getByRole("button", { name: "重试报价" }));
    expect(api.refetchQuote).toHaveBeenCalledOnce();
    expect(api.create).not.toHaveBeenCalled();
});


test.each(["image", "video"] as const)("%s 查看历史保留草稿，只有显式再创作才替换完整输入", async (capability) => {
    api.getBatch.mockImplementation((id) => Promise.resolve(detail(capability, id)));
    saveWorkbenchDraft(capability, { prompt: "尚未提交的内容", references: [], model: `${capability}-1`, settings: { size: "1024x1024" } }, 1);
    render(<router.MemoryRouter initialEntries={[`/${capability}?batch=a`]}><Shell /></router.MemoryRouter>);
    await screen.findByRole("button", { name: "用此批次再创作" });
    expect(screen.getByRole("textbox")).toHaveValue("尚未提交的内容");
    expect(api.confirm).not.toHaveBeenCalled();
    api.confirm.mockImplementation((_yes, no) => no?.());
    fireEvent.click(screen.getByRole("button", { name: "用此批次再创作" }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox")).toHaveValue("尚未提交的内容");
    api.confirm.mockImplementation((yes) => yes());
    fireEvent.click(screen.getByRole("button", { name: "用此批次再创作" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    expect(screen.getByAltText("reference-1")).toHaveAttribute("src", "/api/media/a-reference");
    expect(api.create).not.toHaveBeenCalled();
});

test.each(["image", "video"] as const)("%s 离开页面后恢复编辑内容和参数", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    const view = render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    await waitFor(() => expect(api.getBatch).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "保存这份输入" } });
    act(() => useConfigStore.getState().updateConfig("size", "2048x2048"));
    view.unmount();
    expect(getWorkbenchDraft<{ prompt: string }>(capability)?.prompt).toBe("保存这份输入");
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    expect(screen.getByRole("textbox")).toHaveValue("保存这份输入");
    await waitFor(() => expect(useConfigStore.getState().config.size).toBe("2048x2048"));
});

test.each(["image", "video"] as const)("%s 取消新示例保留输入并清除交接，不阻断后续批次查看", async (capability) => {
    api.getBatch.mockResolvedValue(detail(capability, "a"));
    mount(capability);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    api.confirm.mockImplementation((_yes, no) => no?.());
    act(() => useCreationDraftStore.getState().setDraft({ capability, prompt: "不要覆盖" }));
    await waitFor(() => expect(useCreationDraftStore.getState().draft).toBeNull());
    expect(screen.getByRole("textbox")).toHaveValue("a 的提示词");
});


test("视频再创作保留参考素材类型与全部生成参数", async () => {
    const batch = detail("video", "a");
    batch.referenceMedia = [{ mediaId: "a-reference", originalName: "配音", mimeType: "audio/mpeg" }];
    batch.batch.parameters = { ...batch.batch.parameters, generate_audio: false, watermark: true };
    api.getBatch.mockResolvedValue(batch);
    const view = mount("video");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("a 的提示词"));
    expect(useConfigStore.getState().config).toMatchObject({ videoGenerateAudio: "false", videoWatermark: "true" });
    view.unmount();
    expect(getWorkbenchDraft<{ references: { type: string; name: string }[] }>("video")?.references[0]).toMatchObject({ type: "audio/mpeg", name: "配音" });
});

test.each(["image", "video"] as const)("%s 历史读取期间继续输入，迟到恢复不打断新输入", async (capability) => {
    let resolve!: (detail: GenerationBatchDetail) => void;
    api.getBatch.mockReturnValue(new Promise((done) => { resolve = done; }));
    api.confirm.mockImplementation((_yes, no) => no?.());
    mount(capability);
    await waitFor(() => expect(api.getBatch).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "读取期间的新内容" } });
    await act(async () => resolve(detail(capability, "a")));
    expect(api.confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("读取期间的新内容");
});

test.each(["image", "video"] as const)("%s 刷新后恢复完整本机草稿，历史默认批次不覆盖输入", async (capability) => {
    const saved = { prompt: "完整的本机草稿", references: [{ id: "saved-reference", name: "保留素材", type: "image/png", dataUrl: "/api/media/saved-reference", storageKey: "saved-reference" }], model: `${capability}-2`, settings: capability === "image" ? { size: "2048x2048", quality: "high", count: "3", background: "transparent" } : { size: "1920x1080", vquality: "1080", videoSeconds: "12", videoGenerateAudio: "false", videoWatermark: "true", videoMode: "reference" } };
    api.storedInputs.set(capability, saved);
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(saved.prompt));
    expect(screen.getByTestId("selected-model")).toHaveTextContent(saved.model);
    expect(screen.getByAltText("保留素材")).toHaveAttribute("src", "/api/media/saved-reference");
    expect(useConfigStore.getState().config).toMatchObject(saved.settings);
    expect(api.getBatch).not.toHaveBeenCalled();
    expect(screen.getByText(/预计消费/)).toHaveTextContent("¥0.1");
    expect(screen.getByText("按实际用量结算，未使用金额会退回。")).toBeInTheDocument();
});

test.each(["image", "video"] as const)("%s 读取本机草稿期间的新输入不会被旧草稿覆盖", async (capability) => {
    let finish!: (value: unknown) => void;
    api.readInput.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "现在正在写的内容" } });
    await act(async () => finish({ prompt: "过期本机草稿", references: [], model: `${capability}-2`, settings: {} }));
    expect(screen.getByRole("textbox")).toHaveValue("现在正在写的内容");
    await waitFor(() => expect(api.storedInputs.get(capability)).toMatchObject({ prompt: "现在正在写的内容" }));
    expect(api.getBatch).not.toHaveBeenCalled();
});

test.each(["image", "video"] as const)("%s 本机保存失败可见且保留输入，重试成功后清除提示", async (capability) => {
    api.writeInput.mockRejectedValue(new Error("存储不可用"));
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "不要丢失的输入" } });
    await screen.findByText(/本机草稿保存失败/);
    expect(screen.getByRole("textbox")).toHaveValue("不要丢失的输入");
    api.writeInput.mockImplementation(async (key, value, _session, assertInput) => { assertInput(); api.storedInputs.set(key, value); });
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(screen.queryByText(/本机草稿保存失败/)).not.toBeInTheDocument());
    expect(api.storedInputs.get(capability)).toMatchObject({ prompt: "不要丢失的输入" });
});

test.each(["image", "video"] as const)("%s 全局迟到偏好不覆盖草稿，显式全局参数编辑仍生效", async (capability) => {
    api.storedInputs.set(capability, { prompt: "本机输入", references: [], model: `${capability}-2`, settings: { size: "2048x2048" } });
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("本机输入"));
    act(() => useConfigStore.setState((state) => ({ config: { ...state.config, size: "1:1" } })));
    expect(getWorkbenchDraft<any>(capability)?.settings.size).toBe("2048x2048");
    act(() => useConfigStore.getState().updateConfig("size", "1024x1024"));
    expect(getWorkbenchDraft<any>(capability)?.settings.size).toBe("1024x1024");
});

test.each(["image", "video"] as const)("%s 本机读取失败不覆盖旧存档，继续编辑后重试读取也保留新输入", async (capability) => {
    api.readInput.mockRejectedValueOnce(new Error("存储暂不可读"));
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    await screen.findByText(/本机草稿读取失败/);
    expect(api.writeInput).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "当前新输入" } });
    api.readInput.mockResolvedValueOnce({ prompt: "旧存档", references: [], model: `${capability}-2`, settings: {} });
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    await waitFor(() => expect(screen.queryByText(/本机草稿读取失败/)).not.toBeInTheDocument());
    expect(screen.getByRole("textbox")).toHaveValue("当前新输入");
});

test.each(["image", "video"] as const)("%s 刷新保留未完成上传的文件并可手动恢复", async (capability) => {
    const file = new File(["kept-reference"], "未完成.png", { type: "image/png" });
    api.storedInputs.set(capability, { prompt: "包含未完成上传", references: [], model: `${capability}-1`, settings: {}, uploads: [{ id: "pending", name: file.name, type: file.type, blob: file }] });
    api.upload.mockResolvedValue({ id: "recovered", url: "/api/media/recovered", mimeType: "image/png" });
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    const retry = await screen.findByRole("button", { name: "重试上传 未完成.png" });
    expect(screen.getByRole("button", { name: "workbench.generate" })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(api.upload).toHaveBeenCalledWith(file, file.name));
    await screen.findByAltText("未完成.png");
    expect(getWorkbenchDraft<any>(capability)?.references[0].storageKey).toBe("recovered");
});

test.each(["image", "video"] as const)("%s 切换账号后迟到本机草稿不回填当前输入", async (capability) => {
    let finish!: (value: unknown) => void;
    api.readInput.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(null);
    render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    await waitFor(() => expect(api.readInput).toHaveBeenCalledTimes(1));
    act(() => useUserStore.setState({ sessionVersion: 2, user: { id: "other-user" } }));
    await act(async () => finish({ prompt: "旧账号草稿", references: [], model: `${capability}-2`, settings: {} }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(api.writeInput.mock.calls.filter(([, value, session]) => session === 2 && value.prompt === "旧账号草稿")).toHaveLength(0);
});

test.each(["image", "video"] as const)("%s 模型和草稿已就绪后开始上传，迟到历史就绪不清理新上传", async (capability) => {
    api.historyPending = true;
    let finish!: (value: unknown) => void;
    api.upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<router.MemoryRouter initialEntries={[`/${capability}`]}><Shell /></router.MemoryRouter>);
    await screen.findByText("未提交输入会在本机按账号保留，可刷新后继续。");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留上传中的新草稿" } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["reference"], "历史就绪前.png", { type: "image/png" })] } });
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    act(() => api.finishHistory());
    expect(api.getBatch).not.toHaveBeenCalled();
    await act(async () => finish({ id: "kept-upload", url: "/api/media/kept-upload", mimeType: "image/png" }));
    expect(await screen.findByAltText("历史就绪前.png")).toHaveAttribute("src", "/api/media/kept-upload");
    expect(screen.getByRole("textbox")).toHaveValue("保留上传中的新草稿");
    expect(getWorkbenchDraft<any>(capability)?.references[0].storageKey).toBe("kept-upload");
});
