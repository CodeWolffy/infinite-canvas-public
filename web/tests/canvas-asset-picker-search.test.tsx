import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ session: 1, read: vi.fn() }));
vi.mock("@/services/api/assets", () => ({ listAssetPage: state.read }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: (select: (value: unknown) => unknown) => select({ sessionVersion: state.session }), assertCurrentSession: (session: number) => { if (session !== state.session) throw new DOMException("会话变化", "AbortError"); } }));
vi.mock("@/stores/use-asset-store", () => ({ normalizeAsset: (record: any) => ({ ...record, kind: "text", data: { content: record.content } }), assetCoverUrl: () => "" }));
vi.mock("@/services/image-storage", () => ({ getImagePreviewRevision: () => 0, subscribeImagePreviews: () => () => {} }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("antd", () => ({
    Modal: ({ open, children }: any) => open ? <div>{children}</div> : null,
    Input: ({ value, onChange, placeholder }: any) => <input value={value} onChange={onChange} placeholder={placeholder} />,
    Tag: Object.assign(({ children }: any) => <span>{children}</span>, { CheckableTag: ({ children, onChange }: any) => <button onClick={onChange}>{children}</button> }),
    Empty: Object.assign(({ description }: any) => <p>{description}</p>, { PRESENTED_IMAGE_SIMPLE: "" }),
    Pagination: ({ current, onChange }: any) => <button onClick={() => onChange(current + 1)}>下一页</button>,
    Alert: ({ title, action }: any) => <div role="alert">{title}{action}</div>, Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>, Spin: () => <span>读取中</span>, theme: { useToken: () => ({ token: {} }) },
}));
const { AssetPickerModal } = await import("@/components/canvas/asset-picker-modal");
afterEach(() => { cleanup(); state.read.mockReset(); });
const mount = (insert = vi.fn()) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AssetPickerModal open onClose={() => {}} onInsert={insert} /></QueryClientProvider>);

test("画布素材选择读取服务端后续页，搜索切回第一页并插入完整远端素材", async () => {
    state.read.mockImplementation(async ({ page, keyword }) => ({ assets: [{ id: keyword || String(page), title: keyword ? "很早的目标素材" : `第${page}页素材`, content: "完整文本" }], total: keyword ? 1 : 16 }));
    const insert = vi.fn(); mount(insert);
    expect(await screen.findAllByText("第1页素材")).not.toHaveLength(0);
    fireEvent.click(screen.getByText("下一页"));
    expect(await screen.findAllByText("第2页素材")).not.toHaveLength(0);
    expect(state.read).toHaveBeenLastCalledWith({ page: 2, size: 8, scope: "all", kind: "all", keyword: "" });
    fireEvent.change(screen.getByPlaceholderText("canvas.assetPicker.search"), { target: { value: "目标" } });
    fireEvent.click((await screen.findAllByText("很早的目标素材"))[0]);
    expect(state.read).toHaveBeenLastCalledWith({ page: 1, size: 8, scope: "all", kind: "all", keyword: "目标" });
    expect(insert).toHaveBeenCalledWith({ kind: "text", title: "很早的目标素材", content: "完整文本" });
});

test("类型筛选发往服务端，加载失败有重试入口", async () => {
    state.read.mockRejectedValueOnce(new Error("读取失败")).mockResolvedValue({ assets: [], total: 0 }); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("素材加载失败");
    fireEvent.click(screen.getByText("重试"));
    expect(await screen.findByText("canvas.assetPicker.empty")).toBeInTheDocument();
    fireEvent.click(screen.getByText("assets.kinds.image"));
    await waitFor(() => expect(state.read).toHaveBeenLastCalledWith({ page: 1, size: 8, scope: "all", kind: "image", keyword: "" }));
});
