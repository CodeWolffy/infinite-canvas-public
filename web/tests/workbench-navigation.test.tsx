import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as router from "react-router-dom";
import * as icons from "lucide-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GenerationBatchDetail, PublicModel } from "@/services/api/generation";
import { loadModule, readSource } from "./support/source-loader";

const api = vi.hoisted(() => ({ confirm: vi.fn(), getBatch: vi.fn(), create: vi.fn(), ensure: vi.fn(), upload: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    const useUserStore = create(() => ({ sessionVersion: 1, user: { id: "test-user" } }));
    return { useUserStore, assertCurrentSession: (version: number) => { if (useUserStore.getState().sessionVersion !== version) throw new DOMException("会话已变更", "AbortError"); } };
});
vi.mock("@/services/api/generation", () => ({ getGenerationPreferences: async () => ({}), getGenerationBatch: api.getBatch, createGenerationBatch: api.create, uploadGenerationMedia: vi.fn(), retryGenerationTask: vi.fn(), updateGenerationPreferences: vi.fn() }));

import { useWorkbenchInput } from "@/hooks/use-workbench-input";
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
const workbench = { imageCommand: null, videoCommand: null, clearImageCommand: noop, clearVideoCommand: noop, updateTask: noop };

function useBatches(options: any) {
    const [logs, setLogs] = React.useState<any[]>([]);
    const [previewLog, setPreviewLog] = React.useState<any>(null);
    const [results, setResults] = React.useState<any[]>([]);
    const previewLogIdRef = React.useRef("");
    const applyDetail = (detail: GenerationBatchDetail) => {
        options.onDetail?.(detail);
        const applied = options.toLog(detail);
        setLogs((current) => [applied.log, ...current.filter((log) => log.id !== applied.log.id)]);
        return applied;
    };
    return { logs, setLogs, activeBatchIds: [], setActiveBatchIds: noop, previewLog, setPreviewLog, previewLogIdRef, results, setResults, applyDetail, watchBatch: noop, registerAgentTask: noop, deleteBatches: noop, ensureNotifyPermission: noop };
}

function useBootstrap(options: any) {
    const [initialized, setInitialized] = React.useState(false);
    React.useEffect(() => {
        const available = models.filter((model) => model.capability === options.capability);
        options.modelsRef.current = available;
        options.preferencesRef.current = {};
        options.applyPreferences({}, available);
        options.resolveInitialBatchId([{ id: "other-active", summary: { activeCount: 1 } }]);
        setInitialized(true);
    }, []);
    return { initialized };
}

const imports = {
    react: React, "react/jsx-runtime": jsxRuntime, "react-router-dom": router, "lucide-react": icons,
    antd: { App: { useApp: () => ({ message: { warning: api.warning, error: api.error, success: noop }, modal: { confirm: noop } }) }, Button: button, Drawer: ({ open, children: content }: any) => open ? <div>{content}</div> : null, Empty: empty, Image: image, Input: { TextArea: textarea }, Tag: children, Tooltip: children, Typography: { Text: children } },
    "react-i18next": { useTranslation: () => ({ t }) }, "file-saver": { saveAs: noop }, nanoid: { nanoid: () => "id" },
    "@/i18n": { default: { t, resolvedLanguage: "zh-CN" } },
    "@/components/image-settings-panel": { ImageSettingsPanel: () => null, imageQualityLabel, imageSizeLabel },
    "@/components/video-settings-panel": { VideoSettingsPanel: () => null, normalizeVideoResolutionValue, videoModeLabel, videoSizeLabel },
    "@/components/model-picker": { ModelPicker: ({ value }: any) => <output data-testid="selected-model">{modelOptionName(value)}</output> },
    "@/components/prompts/prompt-select-dialog": { PromptSelectDialog: () => null },
    "@/components/canvas/asset-picker-modal": { AssetPickerModal: () => null },
    "@/components/generation/log-panel": { LogPanel: () => null },
    "@/components/generation/reference-order-buttons": { ReferenceOrderButtons: () => null },
    "@/lib/canvas-theme": { canvasThemes }, "@/lib/creation-draft-model": { resolveCreationDraftModel },
    "@/lib/generation-log": { moveListItem, summaryLogBase }, "@/lib/media-size": { clampVideoSeconds },
    "@/lib/image-reference-prompt": { imageReferenceLabel }, "@/lib/zip": { createZip: noop },
    "@/lib/image-utils": { formatBytes: String, formatDuration: String },
    "@/stores/use-config-store": { useConfigStore, modelOptionName, boolConfig },
    "@/stores/use-theme-store": { useThemeStore: (selector: any) => selector({ theme: "light" }) },
    "@/stores/use-user-store": { useUserStore, assertCurrentSession },
    "@/stores/use-creation-draft-store": { useCreationDraftStore },
    "@/stores/use-asset-store": { useAssetStore: (selector: any) => selector({ addAsset: noop }) },
    "@/stores/use-workbench-agent-store": { useWorkbenchAgentStore: (selector: any) => selector(workbench) },
    "@/services/api/generation": { getGenerationBatch: api.getBatch, createGenerationBatch: api.create, uploadGenerationMedia: api.upload, retryGenerationTask: noop, updateGenerationPreferences: noop },
    "@/services/api/image": { platformImageParameters }, "@/services/api/video": { videoGenerationParameters },
    "@/services/api/media": { mediaId: (key: string) => key.replace(/^(?:image|media):/, "") },
    "@/services/api/tasks": { ensurePlatformMedia: api.ensure, selectedPlatformModel: noop },
    "@/services/image-storage": imageStorage,
    "@/hooks/use-workbench-input": { useWorkbenchInput },
    "@/stores/use-workbench-draft-store": { getWorkbenchDraft },
    "@/hooks/use-confirm-input-replace": { useConfirmInputReplace: () => (dirty: boolean, yes: () => void, no?: () => void) => { if (dirty) api.confirm(yes, no); else yes(); } },
    "@/hooks/use-add-to-canvas": { useAddToCanvas: () => noop },
    "@/hooks/use-save-to-assets": { useSaveToAssets: () => noop },
    "@/hooks/use-generation-quote": { useGenerationQuote: () => ({ quote: { estimatedHold: "0.1" }, ready: true, isFetching: false, error: null }) },
    "@/hooks/use-generation-batches": { useGenerationBatches: useBatches, useWorkbenchBootstrap: useBootstrap, isActiveGenerationTask: (task: any) => ["queued", "running", "reviewing"].includes(task.status), generationTaskDuration: () => 0 },
};
const context = { window, document, navigator, URL, Blob, File, HTMLInputElement, AbortController, DOMException, setTimeout, clearTimeout };
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
});
afterEach(cleanup);

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
    expect(screen.getByTestId("location")).not.toHaveTextContent("batch=");
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
    act(() => navigate(`/${capability}?batch=b&reuse=1`));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("b 的提示词"));
    await act(async () => finish({ id: "a-upload", url: "/api/media/a-upload", mimeType: "image/png" }));
    expect(screen.getByAltText("reference-1")).toHaveAttribute("src", "/api/media/b-reference");
    expect(screen.queryByAltText("A.png")).not.toBeInTheDocument();
    expect(api.error).not.toHaveBeenCalled();
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

test.each(["image", "video"] as const)("%s 历史读取期间继续输入，迟到恢复需要确认", async (capability) => {
    let resolve!: (detail: GenerationBatchDetail) => void;
    api.getBatch.mockReturnValue(new Promise((done) => { resolve = done; }));
    api.confirm.mockImplementation((_yes, no) => no?.());
    mount(capability);
    await waitFor(() => expect(api.getBatch).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "读取期间的新内容" } });
    await act(async () => resolve(detail(capability, "a")));
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toHaveValue("读取期间的新内容");
});
