import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ session: 1, list: vi.fn(), readImage: vi.fn(), zip: vi.fn(), save: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("@/services/api/generation", () => ({
    GENERATION_PAGE_SIZE: 50, listGenerationBatches: state.list, readGenerationImage: state.readImage, deleteGenerationBatch: vi.fn(),
    getGenerationBatch: async () => ({ tasks: [0, 1].map((sequence) => ({ id: String(sequence), sequence, status: "succeeded", image: { mediaId: String(sequence), url: `/image/${sequence}` } })) }),
}));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: Object.assign((select: (value: unknown) => unknown) => select({ sessionVersion: state.session }), { getState: () => ({ sessionVersion: state.session }) }), assertCurrentSession: (session: number) => { if (state.session !== session) throw new DOMException("会话变化", "AbortError"); } }));
vi.mock("@/services/api/assets", () => ({ createAsset: vi.fn() }));
vi.mock("@/stores/use-asset-store", () => ({ useAssetStore: Object.assign((select: any) => select({ hydrateAssets: vi.fn() }), { getState: () => ({}) }) }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("@/components/generation/task-billing-button", () => ({ TaskBillingButton: ({ taskId }: { taskId: string }) => <button data-task-id={taskId}>费用详情</button> }));
vi.mock("@/lib/zip", () => ({ createZip: state.zip }));
vi.mock("file-saver", () => ({ saveAs: state.save }));
vi.mock("react-router-dom", () => ({ Link: ({ children }: any) => <span>{children}</span>, useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("antd", () => ({
    App: { useApp: () => ({ message: { success: state.success, warning: state.warning, error: state.error } }) },
    Button: ({ children, onClick, disabled }: any) => <button onClick={onClick} disabled={disabled}>{children || "操作"}</button>,
    Card: ({ children }: any) => <div>{children}</div>, Tag: ({ children }: any) => <span>{children}</span>,
    Input: ({ value, onChange, placeholder }: any) => <input value={value} onChange={onChange} placeholder={placeholder} />,
    Select: ({ value, onChange, options }: any) => <select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((item: any) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>,
    Empty: Object.assign(({ description, children }: any) => <div>{description}{children}</div>, { PRESENTED_IMAGE_SIMPLE: "" }),
    Image: ({ src }: any) => <img src={src} />, Popconfirm: ({ children }: any) => children, Spin: () => <span>读取中</span>,
    Tooltip: ({ children, title }: any) => <span data-testid={title}>{children}</span>, Alert: ({ title }: any) => <div role="alert">{title}</div>,
}));
const { default: Page } = await import("@/pages/user/generations");
const batch = { id: "batch", prompt: "提示词", createdAt: "2026-11-08", summary: { totalCount: 2, succeededCount: 2, savedCount: 0, activeCount: 0, thumbnailMediaIds: [] } };
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Page /></QueryClientProvider>);
beforeEach(() => { state.session = 1; state.list.mockResolvedValue({ batches: [batch], hasMore: true }); state.readImage.mockResolvedValue({ blob: new Blob(["image"]), extension: "jpg" }); state.zip.mockResolvedValue(new Blob(["zip"])); });
afterEach(() => { cleanup(); vi.clearAllMocks(); state.readImage.mockReset(); state.list.mockReset(); state.zip.mockReset(); });

test("搜索在服务端执行并重置分页，后续空页仍能返回上一页", async () => {
    state.list.mockImplementation(async (_size, offset, keyword) => ({ batches: offset ? [] : [{ ...batch, prompt: keyword ? "更早的命中结果" : "当前结果" }], hasMore: !offset })); mount();
    await screen.findByText("当前结果"); fireEvent.click(screen.getByText("common.nextPage"));
    await waitFor(() => expect(state.list).toHaveBeenLastCalledWith(50, 50, ""));
    await waitFor(() => expect(screen.getByText("common.previousPage")).not.toBeDisabled());
    fireEvent.change(screen.getByPlaceholderText("userCenter.searchPromptPlaceholder"), { target: { value: "历史关键词" } });
    await screen.findByText("更早的命中结果");
    expect(state.list).toHaveBeenLastCalledWith(50, 0, "历史关键词");
});

test("批量下载只打包成功项并反馈部分失败", async () => {
    state.readImage.mockRejectedValueOnce(new Error("HTTP 404")); mount();
    fireEvent.click(await screen.findByText("userCenter.viewDetail"));
    fireEvent.click(within(await screen.findByTestId("userCenter.downloadAllImages")).getByRole("button"));
    await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
    expect(state.zip).toHaveBeenCalledWith([{ name: "image_2.jpg", data: expect.any(Blob) }]);
    expect(state.warning).toHaveBeenCalledWith("已打包 1 张图片，1 张下载失败，可稍后重试");
});

test("全部下载失败不生成空压缩包，打包期间换账号也不下载旧文件", async () => {
    state.readImage.mockRejectedValue(new Error("无效图片")); const view = mount();
    fireEvent.click(await screen.findByText("userCenter.viewDetail"));
    const download = within(await screen.findByTestId("userCenter.downloadAllImages")).getByRole("button");
    fireEvent.click(download); await waitFor(() => expect(state.error).toHaveBeenCalledWith(expect.stringContaining("全部 2 张")));
    expect(state.zip).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
    state.readImage.mockResolvedValue({ blob: new Blob(["image"]), extension: "png" });
    state.zip.mockImplementation(async () => { state.session++; return new Blob(["private"]); });
    fireEvent.click(download); await waitFor(() => expect(state.zip).toHaveBeenCalledOnce());
    expect(state.save).not.toHaveBeenCalled(); view.unmount();
});
