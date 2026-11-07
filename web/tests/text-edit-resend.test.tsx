import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PublicModel } from "@/services/api/generation";
import type { getTextConversation } from "@/services/api/text";
import type { MediaRecord } from "@/services/api/media";

const api = vi.hoisted(() => ({ models: vi.fn(), conversation: vi.fn(), quote: vi.fn(), send: vi.fn(), upload: vi.fn(), ensureMedia: vi.fn() }));
vi.mock("@/services/api/generation", () => ({ getPublicModels: api.models }));
vi.mock("@/services/api/billing", () => ({ getWallet: async () => ({ wallet: { balance: "10" } }) }));
vi.mock("@/services/api/platform-operations", () => ({ quoteGeneration: api.quote }));
vi.mock("@/services/api/media", () => ({ uploadMedia: api.upload, mediaId: (value: string) => value.replace(/^(?:image|media):/, "") }));
vi.mock("@/services/api/tasks", () => ({ cancelGenerationTask: vi.fn(), ensurePlatformMedia: api.ensureMedia }));
vi.mock("@/services/api/text", () => ({
    getTextConversation: api.conversation, listTextConversations: async () => [], queueTextRequest: api.send,
    watchTextRequest: () => () => undefined, deleteTextConversation: vi.fn(),
}));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    const useUserStore = create(() => ({ sessionVersion: 1, user: { role: "user" } }));
    return { useUserStore, assertCurrentSession: (session: number) => { if (session !== useUserStore.getState().sessionVersion) throw new DOMException("会话已变更", "AbortError"); } };
});
vi.mock("@/components/layout/app-providers", () => ({ queryClient: {} }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
import { clearWorkbenchDraft } from "@/stores/use-workbench-draft-store";
import { useUserStore } from "@/stores/use-user-store";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import { workbenchExamples } from "@/constant/creation-scenes";
import TextPage from "@/pages/text";

type Conversation = Awaited<ReturnType<typeof getTextConversation>>;
const model: PublicModel = { id: "vision", name: "vision", displayName: "识图模型", capability: "text", imageInput: true, reasoningEfforts: ["high"], inputPricePerMillion: "1", outputPricePerMillion: "2", sortOrder: 0, description: "解读图片与编写文案" };
const media = (id: string): MediaRecord => ({ id, originalName: `${id}.png`, mimeType: "image/png", byteSize: 3, width: 1, height: 1, createdAt: "2026-01-01", url: `/api/media/${id}` });
const history = (attachments: MediaRecord[] = [media("first"), media("second")]): Conversation => ({
    conversation: { id: "history", title: "原对话", canvasProjectId: null, modelId: model.id, parameters: { systemPrompt: "保留这个系统提示词", reasoningEffort: "high" } },
    messages: [
        { id: "earlier", role: "user", content: "上一轮问题", createdAt: "2026-01-01" },
        { id: "answer", role: "assistant", content: "上一轮回答", createdAt: "2026-01-01" },
        { id: "failed-message", role: "user", content: "解释这两张图片", createdAt: "2026-01-01", attachments },
    ],
    latestRequest: { id: "failed-request", conversationId: "history", responseMessageId: null, status: "failed", errorCode: "upstream_failed", errorMessage: "上游连接断开", createdAt: "2026-01-01", finishedAt: "2026-01-01", billed: "0.12" },
});
let client: QueryClient;
function mount(entry = "/text?conversation=history") {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }}><App><MemoryRouter initialEntries={[entry]}><TextPage /></MemoryRouter></App></ConfigProvider></QueryClientProvider>);
}

beforeEach(() => {
    clearWorkbenchDraft("text:"); clearWorkbenchDraft("text:history");
    useUserStore.setState({ sessionVersion: 1 });
    useCreationDraftStore.getState().clearDraft();
    api.models.mockReset().mockResolvedValue([model]);
    api.conversation.mockReset().mockResolvedValue(history());
    api.quote.mockReset().mockResolvedValue({ quote: { estimatedHold: "0.01" } });
    api.send.mockReset().mockResolvedValue({ conversationId: "history", requestId: "accepted" });
    api.upload.mockReset();
    api.ensureMedia.mockReset().mockImplementation(async (reference) => reference.storageKey);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:local-image"), revokeObjectURL: vi.fn() }));
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("失败后仅恢复最近 user 和全部图片，保留对话与设置，修改后才发送", async () => {
    const user = userEvent.setup();
    mount();
    const retry = await screen.findByRole("button", { name: "编辑后重发" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    const input = screen.getByRole("textbox", { name: "消息内容" });
    expect(input).toHaveValue("解释这两张图片");
    expect(screen.getByRole("button", { name: "移除 first.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 second.png" })).toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
    await user.type(input, "，重点比较颜色");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0][0]).toMatchObject({ conversationId: "history", modelId: "vision", content: "解释这两张图片，重点比较颜色", systemPrompt: "保留这个系统提示词", parameters: { reasoningEffort: "high" }, attachmentMediaIds: ["first", "second"] });
    expect(api.ensureMedia).toHaveBeenCalledTimes(2);
    expect(api.upload).not.toHaveBeenCalled();
});

test("取消替换保护当前文本和图片，明确确认后才恢复失败输入", async () => {
    const user = userEvent.setup();
    const view = mount();
    const retry = await screen.findByRole("button", { name: "编辑后重发" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "我的未提交草稿");
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["img"], "local.png", { type: "image/png" })] } });
    await user.click(retry);
    await user.click(await screen.findByRole("button", { name: "保留当前输入" }));
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("我的未提交草稿");
    expect(screen.getByRole("button", { name: "移除 local.png" })).toBeInTheDocument();
    await user.click(retry);
    await user.click(await screen.findByRole("button", { name: "替换输入" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("解释这两张图片"));
    expect(screen.queryByRole("button", { name: "移除 local.png" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 second.png" })).toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
});

test.each([
    { name: "模型不支持图片", models: [{ ...model, imageInput: false }], attachments: [media("first")], reason: "本次消息含图片，请先选择支持图片的模型再恢复输入。" },
    { name: "图片超过现有上限", models: [model], attachments: Array.from({ length: 21 }, (_, index) => media(`image-${index}`)), reason: "本次消息超过 20 张图片上限，无法完整恢复；请手动整理后发送。" },
    { name: "附件不是图片", models: [model], attachments: [{ ...media("audio"), mimeType: "audio/mpeg" }], reason: "本次消息含不可恢复的附件，请刷新对话核对后重试。" },
])("$name 时不截掉附件或覆盖现有输入", async ({ models, attachments, reason }) => {
    api.models.mockResolvedValue(models);
    api.conversation.mockResolvedValue(history(attachments));
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "保留草稿");
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑后重发" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("保留草稿");
    expect(screen.queryByRole("button", { name: /^移除 / })).not.toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
});

test("确认期间出现新请求时不把旧失败输入覆盖到当前输入", async () => {
    const user = userEvent.setup();
    mount();
    const retry = await screen.findByRole("button", { name: "编辑后重发" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "继续编辑的草稿");
    await user.click(retry);
    const confirm = await screen.findByRole("button", { name: "替换输入" });
    act(() => client.setQueryData<Conversation>(["text-conversation", 1, "history"], (current) => ({ ...current!, latestRequest: { ...current!.latestRequest!, id: "new-request", status: "running" } })));
    await user.click(confirm);
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("继续编辑的草稿");
    expect(api.send).not.toHaveBeenCalled();
});

test("取消请求可恢复文字，缺少结算信息时不根据错误文案宣称退款", async () => {
    const detail = history([]);
    detail.latestRequest = { ...detail.latestRequest!, status: "canceled", billed: undefined, errorMessage: "调用方提示余额已退回" };
    api.conversation.mockResolvedValue(detail);
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText("结算金额尚未返回，请到钱包核对账单。")).toBeInTheDocument();
    await user.click(screen.getByText("查看错误详情"));
    expect(screen.getByText("调用方提示余额已退回")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "编辑后重发" }));
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("解释这两张图片");
    expect(api.send).not.toHaveBeenCalled();
});

test("请求归属与当前对话不同则不恢复其他对话输入", async () => {
    const detail = history();
    detail.latestRequest!.conversationId = "other";
    api.conversation.mockResolvedValue(detail);
    mount();
    expect(await screen.findByRole("button", { name: "编辑后重发" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
});

test("恢复重复图片时按文件去重报价，保留输入中的图片顺序", async () => {
    api.conversation.mockResolvedValue(history([media("first"), media("first"), media("second")]));
    mount();
    const retry = await screen.findByRole("button", { name: "编辑后重发" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(api.quote.mock.lastCall?.[0].attachmentMediaIds).toEqual(["first", "second"]));
    expect(screen.getAllByRole("button", { name: "移除 first.png" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "移除 second.png" })).toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
});

test("报价延迟时在输入附近解释原因，报价完成后可以发送", async () => {
    let resolve!: (value: unknown) => void;
    api.quote.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const user = userEvent.setup();
    mount("/text");
    await screen.findByText("识图模型");
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "测试问题");
    expect(await screen.findByText("正在获取费用报价，完成后即可发送。")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    await act(async () => resolve({ quote: { estimatedHold: "0.01" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
});

test("空页示例复用草稿替换保护流程且不自动发送", async () => {
    const example = workbenchExamples.find((item) => item.example.capability === "text")!;
    const user = userEvent.setup();
    mount("/text");
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "保留我的输入");
    await user.click(screen.getByRole("button", { name: new RegExp(example.title) }));
    await user.click(await screen.findByRole("button", { name: "保留当前输入" }));
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("保留我的输入");
    await user.click(screen.getByRole("button", { name: new RegExp(example.title) }));
    await user.click(await screen.findByRole("button", { name: "替换输入" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue(example.example.prompt));
    expect(api.send).not.toHaveBeenCalled();
});

test("普通用户无模型时看到联系管理员而不是配置渠道", async () => {
    api.models.mockResolvedValue([]);
    mount("/text");
    expect((await screen.findAllByText("暂无可用文本模型，请联系管理员开通。"))[0]).toBeVisible();
    expect(screen.queryByText(/管理后台|渠道配置/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
});
