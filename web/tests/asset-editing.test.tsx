import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssetRecord } from "@/services/api/assets";

const api = vi.hoisted(() => ({ list: vi.fn(), recent: vi.fn(), get: vi.fn(), update: vi.fn(), create: vi.fn(), upload: vi.fn(), readMeta: vi.fn(), readCover: vi.fn() }));
vi.mock("@/services/api/assets", () => ({ ASSET_PAGE_SIZE: 100, listAssetPage: api.list, listRecentAssets: api.recent, getAsset: api.get, updateAsset: api.update, createAsset: api.create, deleteAsset: vi.fn() }));
vi.mock("@/services/api/media", () => ({ uploadMedia: api.upload, readMedia: vi.fn(), mediaUrl: (id: string) => `/api/media/${id}`, mediaId: (key: string) => key.replace(/^image:/, "") }));
vi.mock("@/lib/image-utils", () => ({ formatBytes: (bytes: number) => `${bytes} B`, readImageMeta: api.readMeta, readFileAsDataUrl: api.readCover }));
vi.mock("@/lib/image-thumbnail", () => ({ createImageThumbnail: async () => undefined }));
vi.mock("localforage", () => ({ default: { createInstance: () => ({ getItem: async () => ({ version: 1 }), setItem: async () => undefined }) } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    const useUserStore = create(() => ({ sessionVersion: 1, user: { id: "owner", role: "user" } }));
    return { useUserStore, assertCurrentSession: (version: number) => { if (version !== useUserStore.getState().sessionVersion) throw new DOMException("会话已变化", "AbortError"); } };
});
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("@/components/share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("@/components/workspace-move-button", () => ({ WorkspaceMoveButton: () => null }));
vi.mock("@/pages/assets/use-asset-creation", () => ({ useAssetCreation: () => [] }));
vi.mock("@/pages/assets/asset-transfer", () => ({ exportAssets: vi.fn(), readAssetPackage: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: vi.fn() }));
vi.mock("@/pages/admin/components/admin-user-select", () => ({ AdminUserSelect: ({ value, onChange }: { value?: string; onChange: (value: string | undefined) => void }) => <select aria-label="创建者筛选" value={value || ""} onChange={(event) => onChange(event.target.value || undefined)}><option value="">全部创建者</option><option value="late-owner">靠后用户</option></select> }));

import AssetsPage from "@/pages/assets";
import AdminAssetsPage from "@/pages/admin/assets";
import { normalizeAsset, useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { ApiError } from "@/services/api/request";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const record = (id: string, type: "text" | "image" = "image"): AssetRecord => ({ id, revision: 0, ownerId: "owner", scope: "private", type, title: id, content: "原文", mediaId: type === "image" ? id : null, metadata: { tags: ["保留标签"], source: "来源", width: 100, height: 100, bytes: 10, mimeType: "image/png", custom: "保留元数据" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const meta = { width: 200, height: 300, mimeType: "image/png" };
const media = (id: string) => ({ id, url: `/api/media/${id}`, byteSize: 20, ...meta });
const file = (name: string) => new File([name], name, { type: "image/png" });
let client: QueryClient;
function mount(admin = false) {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }}><App>{admin ? <AdminAssetsPage /> : <AssetsPage />}</App></ConfigProvider></QueryClientProvider>);
}
async function edit(id: string) {
    fireEvent.click(await screen.findByRole("button", { name: `${id}的更多操作` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "common.edit" }));
    await screen.findByRole("dialog");
}
function selectFile(kind: "cover" | "image", name: string) {
    const input = screen.getByRole("dialog").querySelectorAll<HTMLInputElement>('input[type="file"]')[kind === "cover" ? 0 : 1];
    fireEvent.change(input, { target: { files: [file(name)] } });
}
const cover = () => screen.getByPlaceholderText("assets.fields.coverPlaceholder");
const save = () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "common.save" }));
const close = () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "common.cancel" }));
beforeEach(() => {
    vi.clearAllMocks();
    useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 }));
    api.list.mockReset().mockResolvedValue({ assets: [record("A"), record("B")], total: 2 });
    api.recent.mockReset().mockResolvedValue([]);
    api.update.mockReset().mockImplementation(async (id, input) => ({ ...record(id, input.type), ...input }));
    api.get.mockReset().mockImplementation(async (id) => record(id));
    api.create.mockReset().mockImplementation(async (input) => ({ ...record("created", input.type), ...input }));
    api.upload.mockReset().mockImplementation(async (_blob, name) => media(name));
    api.readMeta.mockReset().mockResolvedValue(meta);
    api.readCover.mockReset().mockResolvedValue("data:image/png;base64,new");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:prepared"), revokeObjectURL: vi.fn() }));
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("搜索命中的旧素材不在最近缓存中仍可编辑，提交已加载记录并保留元数据", async () => {
    api.list.mockImplementation(async ({ keyword }) => ({ assets: keyword ? [record("旧素材", "text")] : [], total: keyword ? 1 : 0 }));
    const user = userEvent.setup(); mount();
    await user.type(screen.getByPlaceholderText("assets.search"), "旧素材");
    await edit("旧素材");
    expect(useAssetStore.getState().assets).toEqual([]);
    fireEvent.change(screen.getByPlaceholderText("assets.fields.titlePlaceholder"), { target: { value: "修改标题" } });
    save();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("旧素材", expect.objectContaining({ title: "修改标题", content: "原文", metadata: expect.objectContaining({ custom: "保留元数据", tags: ["保留标签"] }) })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

test("编辑权限由后端决定，拒绝时保留表单和最近缓存", async () => {
    const cached = normalizeAsset(record("最近素材", "text"));
    useAssetStore.getState().replaceAssets([cached]);
    api.update.mockRejectedValue(new Error("服务端拒绝编辑"));
    mount(); await edit("A"); save();
    expect(await screen.findByText("服务端拒绝编辑")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(useAssetStore.getState().assets).toEqual([cached]);
});

test("缓存中的旧权限标记不会替代服务端权限判断", async () => {
    const current = { ...normalizeAsset(record("已授权", "text")), editable: false };
    await useAssetStore.getState().updateAsset(current, { title: "新标题" });
    expect(api.update).toHaveBeenCalledWith("已授权", expect.objectContaining({ title: "新标题" }));
});

test.each(["关闭重开", "切换素材", "切换会话", "卸载"])("图片准备期间%s，准备完成不发起上传", async (change) => {
    const prepared = deferred<typeof meta>(); api.readMeta.mockReturnValueOnce(prepared.promise);
    const view = mount(); await edit("A"); selectFile("image", "旧图片.png");
    await waitFor(() => expect(api.readMeta).toHaveBeenCalledTimes(1));
    if (change === "切换会话") act(() => useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 })));
    else if (change === "卸载") view.unmount();
    else if (change === "关闭重开") { close(); fireEvent.click(screen.getByRole("button", { name: "assets.add" })); }
    else await edit("B");
    await act(async () => prepared.resolve(meta));
    expect(api.upload).not.toHaveBeenCalled();
    if (change === "切换素材") expect(cover()).toHaveValue("/api/media/B");
    if (change === "关闭重开") expect(cover()).toHaveValue("");
});

test("重新选图会取消旧图片的准备，只有最新文件上传", async () => {
    const prepared = deferred<typeof meta>(); api.readMeta.mockReturnValueOnce(prepared.promise);
    mount(); await edit("A"); selectFile("image", "旧图片.png"); selectFile("image", "新图片.png");
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    await act(async () => prepared.resolve(meta));
    expect(api.upload.mock.calls[0][1]).toBe("新图片.png");
    expect(api.upload).toHaveBeenCalledTimes(1);
});

test("旧图片请求晚到不会覆盖重选文件，保存使用最新图片", async () => {
    const old = deferred<ReturnType<typeof media>>(); api.upload.mockReturnValueOnce(old.promise);
    mount(); await edit("A"); selectFile("image", "旧图片.png");
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    selectFile("image", "新图片.png");
    await screen.findByText("200x300 · 20 B");
    await act(async () => old.resolve({ ...media("旧图片.png"), width: 999 }));
    save();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("A", expect.objectContaining({ mediaId: "新图片.png" })));
});

test("图片上传请求晚到不能写入另一个素材表单", async () => {
    const old = deferred<ReturnType<typeof media>>(); api.upload.mockReturnValueOnce(old.promise);
    mount(); await edit("A"); selectFile("image", "旧图片.png");
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    await edit("B");
    await act(async () => old.resolve(media("旧图片.png")));
    expect(cover()).toHaveValue("/api/media/B");
    save();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("B", expect.objectContaining({ mediaId: "B" })));
});

test("封面读取乱序完成保留最新文件，手动输入也使旧读取失效", async () => {
    const first = deferred<string>(); const third = deferred<string>();
    api.readCover.mockReturnValueOnce(first.promise).mockResolvedValueOnce("data:image/png;base64,second").mockReturnValueOnce(third.promise);
    mount(); await edit("A"); selectFile("cover", "第一张.png"); selectFile("cover", "第二张.png");
    await waitFor(() => expect(cover()).toHaveValue("data:image/png;base64,second"));
    await act(async () => first.resolve("data:image/png;base64,first"));
    expect(cover()).toHaveValue("data:image/png;base64,second");
    selectFile("cover", "第三张.png"); fireEvent.change(cover(), { target: { value: "https://example.test/manual.png" } });
    await act(async () => third.resolve("data:image/png;base64,third"));
    expect(cover()).toHaveValue("https://example.test/manual.png");
});

test.each(["关闭重开", "切换素材", "切换会话"])("封面读取期间%s，晚到结果不写入新表单", async (change) => {
    const pending = deferred<string>(); api.readCover.mockReturnValueOnce(pending.promise);
    mount(); await edit("A"); selectFile("cover", "旧封面.png");
    if (change === "关闭重开") { close(); fireEvent.click(screen.getByRole("button", { name: "assets.add" })); }
    else if (change === "切换素材") await edit("B");
    else { act(() => useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 }))); fireEvent.click(screen.getByRole("button", { name: "assets.add" })); }
    await act(async () => pending.resolve("data:image/png;base64,old"));
    expect(cover()).toHaveValue(change === "切换素材" ? "/api/media/B" : "");
});

test("旧保存请求完成不会关闭后来打开的素材表单", async () => {
    const old = deferred<AssetRecord>(); api.update.mockReturnValueOnce(old.promise);
    mount(); await edit("A"); save();
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    await edit("B");
    await act(async () => old.resolve(record("A")));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByPlaceholderText("assets.fields.titlePlaceholder")).toHaveValue("B");
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "common.save" })).toBeEnabled();
});

test("版本冲突保留输入，查看最新不替换表单，并可另存私人副本", async () => {
    api.list.mockResolvedValue({ assets: [{ ...record("共享原文", "text"), revision: 3 }], total: 1 });
    api.update.mockRejectedValue(new ApiError("素材已更新", 409, "asset_conflict"));
    api.get.mockResolvedValue({ ...record("共享原文", "text"), revision: 4, title: "远端标题", content: "其他人的最新正文" });
    mount(); await edit("共享原文");
    fireEvent.change(screen.getByPlaceholderText("assets.fields.titlePlaceholder"), { target: { value: "我的修订" } });
    fireEvent.change(screen.getByPlaceholderText("assets.fields.textPlaceholder"), { target: { value: "我的正文" } });
    save();
    await screen.findByText("素材已有更新，当前输入已保留");
    expect(api.update).toHaveBeenCalledWith("共享原文", expect.objectContaining({ expectedRevision: 3, title: "我的修订", content: "我的正文" }));
    expect(screen.getByPlaceholderText("assets.fields.titlePlaceholder")).toHaveValue("我的修订");
    fireEvent.click(screen.getByRole("button", { name: "查看最新" }));
    expect((await screen.findAllByText("其他人的最新正文"))[0]).toBeVisible();
    expect(screen.getByPlaceholderText("assets.fields.textPlaceholder")).toHaveValue("我的正文");
    fireEvent.click(screen.getByRole("button", { name: "另存私人副本" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ scope: "private", title: "我的修订", content: "我的正文" })));
    expect(api.update).toHaveBeenCalledTimes(1);
});

test("后台公共素材按服务端总数分页，创建者选择与关键词一起下发", async () => {
    api.list.mockImplementation(async ({ page }) => ({ assets: [{ ...record(`第${page}页素材`, "text"), ownerName: "服务端创建者" }], total: 1020 }));
    mount(true);
    expect(await screen.findByText("共 1020 条公共素材")).toBeVisible();
    expect(screen.getByText("服务端创建者")).toBeVisible();
    fireEvent.click(screen.getByTitle("2"));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, size: 20, scope: "public" })));
    fireEvent.change(screen.getByRole("combobox", { name: "创建者筛选" }), { target: { value: "late-owner" } });
    fireEvent.change(screen.getByPlaceholderText("搜索素材标题、正文或标签"), { target: { value: "标签" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, ownerId: "late-owner", keyword: "标签" })));
});

test("后台冲突带上编辑版本，保留输入并支持另存私人副本", async () => {
    api.list.mockResolvedValue({ assets: [{ ...record("公共旧文", "text"), revision: 8 }], total: 1 });
    api.update.mockRejectedValue(new ApiError("素材已更新", 409, "asset_conflict"));
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: /编\s*辑/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "标题" }), { target: { value: "我的公共修订" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("素材已有更新，当前输入已保留");
    expect(api.update).toHaveBeenCalledWith("公共旧文", expect.objectContaining({ expectedRevision: 8, title: "我的公共修订" }));
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("我的公共修订");
    fireEvent.click(screen.getByRole("button", { name: "另存私人副本" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ title: "我的公共修订", scope: "private", type: "text" })));
    expect(api.update).toHaveBeenCalledTimes(1);
});

test("查看最新期间切换素材，迟到快照不打开旧素材详情", async () => {
    const pending = deferred<AssetRecord>(); api.get.mockReturnValueOnce(pending.promise);
    api.update.mockRejectedValue(new ApiError("素材已更新", 409, "asset_conflict"));
    mount(); await edit("A"); save();
    await screen.findByText("素材已有更新，当前输入已保留");
    fireEvent.click(screen.getByRole("button", { name: "查看最新" }));
    await edit("B");
    await act(async () => pending.resolve({ ...record("A", "text"), content: "不应打开的旧详情" }));
    expect(screen.queryByText("不应打开的旧详情")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("assets.fields.titlePlaceholder")).toHaveValue("B");
});
