import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { getTextConversation, TextRequestDetail } from "@/services/api/text";

const api = vi.hoisted(() => ({ models: vi.fn(), conversation: vi.fn(), request: vi.fn(), list: vi.fn(), quote: vi.fn(), send: vi.fn(), upload: vi.fn(), update: vi.fn(), watch: vi.fn(), ensure: vi.fn(), renderText: vi.fn(), holdSearchNavigation: false }));
vi.mock("react-router-dom", async (importOriginal) => {
    const original = await importOriginal<typeof import("react-router-dom")>();
    return { ...original, useSearchParams: () => {
        const [search, setSearch] = original.useSearchParams();
        return [search, api.holdSearchNavigation ? () => undefined : setSearch];
    } };
});
vi.mock("@/services/api/generation", () => ({ getPublicModels: api.models }));
vi.mock("@/services/api/billing", () => ({ getWallet: async () => ({ wallet: { balance: "10" } }) }));
vi.mock("@/services/api/platform-operations", () => ({ quoteGeneration: api.quote }));
vi.mock("@/services/api/media", () => ({ uploadMedia: api.upload, mediaId: (id: string) => id }));
vi.mock("@/services/api/tasks", () => ({ cancelGenerationTask: vi.fn(), ensurePlatformMedia: api.ensure }));
vi.mock("@/services/api/text", () => ({ getTextConversation: api.conversation, getTextRequest: api.request, listTextConversations: api.list, queueTextRequest: api.send, updateTextConversation: api.update, watchTextRequest: api.watch, deleteTextConversation: vi.fn() }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    const useUserStore = create(() => ({ sessionVersion: 1, user: { role: "user" } }));
    return { useUserStore, assertCurrentSession: (session: number) => { if (session !== useUserStore.getState().sessionVersion) throw new DOMException("会话已变更", "AbortError"); } };
});
vi.mock("@/components/layout/app-providers", () => ({ queryClient: {} }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => { api.renderText(children); return <div>{children}</div>; } }));

import TextPage from "@/pages/text";
import { clearWorkbenchDraft, saveWorkbenchDraft } from "@/stores/use-workbench-draft-store";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import { useUserStore } from "@/stores/use-user-store";
import { ApiError } from "@/services/api/request";

type Conversation = Awaited<ReturnType<typeof getTextConversation>>;
const model = { id: "vision", name: "vision", displayName: "识图模型", capability: "text", imageInput: true, reasoningEfforts: [], sortOrder: 0, description: "写作" };
const detail = (): Conversation => ({ conversation: { id: "history", title: "原对话", canvasProjectId: null, modelId: "vision", parameters: {} }, messages: [
    { id: "u1", role: "user", content: "原始问题", createdAt: "2026-01-01" },
    { id: "a1", role: "assistant", content: "原始回答", createdAt: "2026-01-01", requestId: "r1", requestMessageId: "u1", modelDisplayName: "识图模型", billed: "0.03", finishReason: "length" },
], latestRequest: { id: "r1", conversationId: "history", responseMessageId: "a1", status: "succeeded", errorCode: null, createdAt: "2026-01-01", finishedAt: "2026-01-01", billed: "0.03", finishReason: "length" } });
let client: QueryClient;
const scrollIntoView = vi.fn();
function mount(entry = "/text?conversation=history") {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }}><App><MemoryRouter initialEntries={[entry]}><TextPage /></MemoryRouter></App></ConfigProvider></QueryClientProvider>);
}
beforeEach(() => {
    vi.clearAllMocks();
    api.holdSearchNavigation = false;
    clearWorkbenchDraft("text:"); clearWorkbenchDraft("text:history"); clearWorkbenchDraft("text:old");
    useUserStore.setState({ sessionVersion: 1 }); useCreationDraftStore.getState().clearDraft();
    api.models.mockResolvedValue([model]); api.conversation.mockResolvedValue(detail()); api.list.mockResolvedValue([]);
    api.quote.mockResolvedValue({ quote: { estimatedHold: "0.01" }, context: { messageCount: 3, imageCount: 0, estimatedTokens: 123, contextWindow: null } });
    api.send.mockReset().mockResolvedValue({ conversationId: "history", requestId: "accepted" });
    api.upload.mockReset(); api.ensure.mockImplementation(async (reference) => reference.storageKey); api.update.mockResolvedValue(undefined); api.watch.mockImplementation(() => () => undefined);
    api.request.mockReset();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() }));
    Element.prototype.scrollIntoView = scrollIntoView;
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("搜索把关键词传到服务端并定位未加载过的历史正文", async () => {
    api.list.mockImplementation(async (_offset, keyword) => keyword ? [{ id: "old", title: "与关键词无关的标题", excerpt: "正文里的月亮", matchedMessageId: "a1", updatedAt: "2026-01-01" }] : []);
    api.conversation.mockImplementation(async (id) => ({ ...detail(), conversation: { ...detail().conversation, id } }));
    const user = userEvent.setup(); mount();
    await user.type(screen.getAllByPlaceholderText("搜索标题和消息")[0], "月亮");
    await user.click(await screen.findByRole("button", { name: /与关键词无关的标题/ }));
    await waitFor(() => expect(api.conversation).toHaveBeenCalledWith("old"));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" }));
    expect(api.list.mock.calls.some((call) => call[1] === "月亮")).toBe(true);
});

test("重命名、置顶和归档通过服务端保存，归档列表可单独读取", async () => {
    api.list.mockResolvedValue([{ id: "history", title: "原对话", updatedAt: "2026-01-01", pinned: false, archivedAt: null }]);
    const user = userEvent.setup(); mount();
    await user.click((await screen.findAllByRole("button", { name: "更多操作" }))[0]);
    await user.click(await screen.findByText("重命名"));
    const name = screen.getByRole("textbox", { name: "对话名称" });
    await user.clear(name); await user.type(name, "新的名字");
    await user.click(screen.getByRole("button", { name: "保 存" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("history", { title: "新的名字" }));
    await user.click(screen.getAllByRole("button", { name: "更多操作" })[0]); await user.click(await screen.findByText("置顶"));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("history", { pinned: true }));
    await user.click(screen.getAllByRole("button", { name: "更多操作" })[0]); await user.click(await screen.findByText("归档"));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("history", { archived: true }));
    await user.click(screen.getAllByRole("button", { name: "查看已归档" })[0]);
    await waitFor(() => expect(api.list.mock.calls.some((call) => call[2] === true)).toBe(true));
});

test("编辑成功问题只准备输入，报价与发送携带同一编辑目标且旧回答保留", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "编辑消息" }));
    expect(api.send).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "消息内容" });
    await user.clear(input); await user.type(input, "修订的问题");
    await waitFor(() => expect(api.quote.mock.lastCall?.[0]).toMatchObject({ action: "edit", targetMessageId: "u1", content: "修订的问题" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0][0]).toMatchObject({ action: "edit", targetMessageId: "u1", content: "修订的问题" });
    expect(screen.getByText("原始回答")).toBeVisible();
});

test("重新生成使用原问题和原附件目标，等待用户确认发送", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "重新生成回复" }));
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("原始问题");
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveAttribute("readonly");
    expect(api.send).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send.mock.calls[0][0]).toMatchObject({ action: "regenerate", targetMessageId: "a1" }));
});

test("达到上限后继续写是普通新消息，预警不阻止发送", async () => {
    api.quote.mockResolvedValue({ quote: { estimatedHold: "0.01" }, context: { messageCount: 3, imageCount: 0, estimatedTokens: 123, contextWindow: 100, warning: "预估上下文超过容量，仍可发送" } });
    const user = userEvent.setup(); mount(); await user.click(await screen.findByRole("button", { name: "继续写" }));
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("请从上一条回复中断的位置继续，不要重复已有内容。");
    expect(await screen.findByText("预估上下文超过容量，仍可发送")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0][0].action).toBeUndefined();
});

test("部分上传失败保留成功文件，单项重试后只提交一次且不重复上传", async () => {
    api.upload.mockImplementation(async (file: File) => { if (file.name === "bad.png" && api.upload.mock.calls.filter(([entry]) => entry.name === "bad.png").length === 1) throw new Error("网络错误"); return { id: file.name }; });
    const user = userEvent.setup(); const view = mount();
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "比较图片");
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "ok.png", { type: "image/png" }), new File(["b"], "bad.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled()); await user.click(screen.getByRole("button", { name: "发送消息" }));
    await user.click(await screen.findByRole("button", { name: "上传失败，重试" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "上传失败，重试" })).not.toBeInTheDocument());
    expect(api.send).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled()); await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.upload).toHaveBeenCalledTimes(3);
    expect(api.send.mock.calls[0][0].attachmentMediaIds).toEqual(["ok.png", "bad.png"]);
});

test("上传成功但提交响应丢失时，再次发送沿用同一请求编号", async () => {
    api.upload.mockResolvedValue({ id: "uploaded" });
    api.send.mockRejectedValueOnce(new Error("连接中断"));
    const user = userEvent.setup(); const view = mount();
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "解释图片");
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "ok.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled()); await user.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("消息提交未完成，输入已保留。");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled()); await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send.mock.calls[1][0].requestId).toBe(api.send.mock.calls[0][0].requestId);
    expect(api.upload).toHaveBeenCalledTimes(1);
});

test("连接不可读后刷新同一活动请求会重建订阅，不重发生成", async () => {
    const current = detail(); current.latestRequest = { ...current.latestRequest!, responseMessageId: null, status: "running", canCancel: false };
    api.conversation.mockResolvedValue(current);
    const user = userEvent.setup(); mount();
    await waitFor(() => expect(api.watch).toHaveBeenCalledTimes(1));
    act(() => api.watch.mock.calls[0][3](new Error("连接失败")));
    await user.click(await screen.findByRole("button", { name: "刷新对话" }));
    await waitFor(() => expect(api.watch).toHaveBeenCalledTimes(2));
    expect(api.watch.mock.calls[1][0]).toBe("r1"); expect(api.send).not.toHaveBeenCalled();
    act(() => api.watch.mock.calls[1][1]({ request: detail().latestRequest!, message: detail().messages[1] } satisfies TextRequestDetail));
});

test("搜索可展开旧记录，但旧记录没有编辑与重新生成操作", async () => {
    const current = detail(); current.messages = current.messages.map((item) => ({ ...item, supersededAt: "2026-01-02" })); api.conversation.mockResolvedValue(current);
    mount("/text?conversation=history&message=a1");
    expect(await screen.findByText("原始回答")).toBeVisible();
    const row = document.getElementById("text-message-a1")!;
    expect(within(row).queryByRole("button", { name: "重新生成回复" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑消息" })).not.toBeInTheDocument();
});

test.each([false, true])("搜索定位只消费一次，导航等待 %s 时用户随后可收起旧记录", async (holdSearchNavigation) => {
    api.holdSearchNavigation = holdSearchNavigation;
    const current = detail(); current.messages = current.messages.map((item) => ({ ...item, supersededAt: "2026-01-02" })); api.conversation.mockResolvedValue(current);
    const user = userEvent.setup(); mount("/text?conversation=history&message=a1");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const summary = screen.getByText(/历史记录 · 2 条/);
    await user.click(summary);
    await waitFor(() => expect(summary.closest("details")).not.toHaveAttribute("open"));
    expect(screen.queryByText("原始回答")).not.toBeInTheDocument();
});

test("收起后再次搜索同一条旧消息仍可展开并定位", async () => {
    const current = detail(); current.messages = current.messages.map((item) => ({ ...item, supersededAt: "2026-01-02" })); api.conversation.mockResolvedValue(current);
    api.list.mockResolvedValue([{ id: "history", title: "再次定位", matchedMessageId: "a1", updatedAt: "2026-01-01" }]);
    const user = userEvent.setup(); mount("/text?conversation=history&message=a1");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText(/历史记录 · 2 条/));
    await waitFor(() => expect(screen.queryByText("原始回答")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "再次定位" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(screen.getByText("原始回答")).toBeVisible();
});

test("重新生成模式不接受粘贴的新图片", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "重新生成回复" }));
    fireEvent.paste(screen.getByRole("textbox", { name: "消息内容" }), { clipboardData: { files: [new File(["image"], "unexpected.png", { type: "image/png" })] } });
    expect(screen.queryByAltText("unexpected.png")).not.toBeInTheDocument();
    expect(api.upload).not.toHaveBeenCalled();
});

test("流式生成时不报下一问的旧价，回复完成后按新历史重新报价", async () => {
    const current = detail(); current.messages = [current.messages[0]]; current.latestRequest = { ...current.latestRequest!, status: "running", responseMessageId: null };
    api.conversation.mockResolvedValue(current);
    const user = userEvent.setup(); mount();
    await waitFor(() => expect(api.watch).toHaveBeenCalled());
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "下一问");
    expect(api.quote).not.toHaveBeenCalled();
    api.conversation.mockResolvedValue(detail());
    act(() => api.watch.mock.lastCall![1]({ request: detail().latestRequest!, message: detail().messages[1] } satisfies TextRequestDetail));
    await waitFor(() => expect(api.quote).toHaveBeenCalled());
    expect(api.quote.mock.lastCall![0].content).toBe("下一问");
});

test("恢复待确认提交先找回服务端对话，不再次生成", async () => {
    saveWorkbenchDraft("text:", { prompt: "已被服务端接收", modelId: "vision", systemPrompt: "", reasoningEffort: "auto", files: [], submission: { id: "accepted", fingerprint: "pending", mediaIds: [] } }, 1);
    api.request.mockResolvedValue({ request: { ...detail().latestRequest!, id: "accepted" }, message: detail().messages[1] });
    mount("/text");
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("accepted"));
    await waitFor(() => expect(api.conversation).toHaveBeenCalledWith("history"));
    expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
    expect(api.send).not.toHaveBeenCalled();
});

test("确认服务端尚未接收后重试仍沿用持久化请求编号和附件", async () => {
    saveWorkbenchDraft("text:history", { prompt: "待提交问题", modelId: "vision", systemPrompt: "", reasoningEffort: "auto", files: [], submission: { id: "pending-id", fingerprint: "pending", mediaIds: [] } }, 1);
    api.request.mockRejectedValue(new ApiError("不存在", 404));
    const user = userEvent.setup(); mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send.mock.lastCall![0].requestId).toBe("pending-id"));
});

test("200条历史消息在流式更新时不重复渲染历史Markdown", async () => {
    const current = detail(); current.messages = Array.from({ length: 200 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? "assistant" : "user", content: `历史-${index}`, createdAt: "2026-01-01" })); current.latestRequest = { ...current.latestRequest!, status: "running", responseMessageId: null };
    api.conversation.mockResolvedValue(current); mount();
    await waitFor(() => expect(api.watch).toHaveBeenCalled());
    const count = () => api.renderText.mock.calls.filter(([text]) => String(text).startsWith("历史-")).length;
    const initial = count(); expect(initial).toBe(100);
    act(() => api.watch.mock.lastCall![1]({ request: { ...current.latestRequest!, partialText: "新的流式内容", streamSequence: 1 }, message: null } satisfies TextRequestDetail));
    expect(await screen.findByText("新的流式内容")).toBeVisible();
    expect(count()).toBe(initial);
});
