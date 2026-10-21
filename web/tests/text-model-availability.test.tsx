import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PublicModel } from "@/services/api/generation";
import type { getTextConversation } from "@/services/api/text";

const api = vi.hoisted(() => ({ models: vi.fn(), conversation: vi.fn(), quote: vi.fn(), send: vi.fn() }));
vi.mock("@/services/api/generation", () => ({ getPublicModels: api.models }));
vi.mock("@/services/api/billing", () => ({ getWallet: async () => ({ wallet: { balance: "10" } }) }));
vi.mock("@/services/api/platform-operations", () => ({ quoteGeneration: api.quote }));
vi.mock("@/services/api/text", () => ({
    getTextConversation: api.conversation, listTextConversations: async () => [], queueTextRequest: api.send,
    watchTextRequest: () => () => undefined, deleteTextConversation: vi.fn(),
}));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: Object.assign((select: (value: { sessionVersion: number }) => unknown) => select({ sessionVersion: 1 }), { getState: () => ({ sessionVersion: 1 }) }),
    assertCurrentSession: (session: number) => { if (session !== 1) throw new DOMException("会话已变更", "AbortError"); },
}));
vi.mock("@/components/layout/app-providers", () => ({ queryClient: {} }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
import TextPage from "@/pages/text";

const model = (id: string, displayName: string): PublicModel => ({ id, name: id, displayName, capability: "text", inputPricePerMillion: "1", outputPricePerMillion: "2", sortOrder: 0, description: null });
const first = model("first", "原文本模型");
const replacement = model("replacement", "可用文本模型");
const saved = (modelId: string): Awaited<ReturnType<typeof getTextConversation>> => ({ conversation: { id: "history", title: "历史对话", canvasProjectId: null, modelId }, messages: [], latestRequest: null });
let client: QueryClient;

function mount(entry = "/text") {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><App><MemoryRouter initialEntries={[entry]}><TextPage /></MemoryRouter></App></QueryClientProvider>);
}

beforeEach(() => {
    api.models.mockReset().mockResolvedValue([replacement]);
    api.conversation.mockReset().mockResolvedValue(saved("retired"));
    api.quote.mockReset().mockResolvedValue({ quote: { estimatedHold: "0.01" } });
    api.send.mockReset().mockResolvedValue({ conversationId: "history", requestId: "accepted" });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("恢复下线模型的对话不会用首个可用模型报价或发送，明确选新模型后才发送", async () => {
    let restore!: (value: Awaited<ReturnType<typeof getTextConversation>>) => void;
    api.conversation.mockImplementationOnce(() => new Promise((resolve) => { restore = resolve; }));
    const user = userEvent.setup();
    mount("/text?conversation=history");
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "继续回答");
    expect(api.quote).not.toHaveBeenCalled();
    await act(async () => restore(saved("retired")));
    expect(await screen.findByText("已选模型已下线或暂无可用渠道，请明确选择其它模型后继续发送")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(api.quote).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox", { name: "选择文本模型" }));
    await user.click(await screen.findByText("可用文本模型"));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0][0]).toMatchObject({ modelId: "replacement", conversationId: "history", content: "继续回答" });
    expect(api.quote.mock.calls.every(([input]) => input.modelId === "replacement")).toBe(true);
});

test("异步模型列表移除已选模型后，保留原选择并禁止发送与替代报价", async () => {
    api.models.mockResolvedValue([first, replacement]);
    const user = userEvent.setup();
    mount();
    await screen.findByText("原文本模型");
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "问题");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    const quotes = api.quote.mock.calls.length;
    act(() => { client.setQueryData(["public-models", 1], [replacement]); });
    await screen.findByText("已选模型不可用");
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(api.quote).toHaveBeenCalledTimes(quotes);
    expect(api.send).not.toHaveBeenCalled();
});

test("从失效模型历史新建对话时重新初始化默认模型", async () => {
    const user = userEvent.setup();
    mount("/text?conversation=history");
    await screen.findByText("已选模型不可用");
    await user.click(screen.getAllByRole("button", { name: "新建对话" })[0]);
    expect(await screen.findByText("可用文本模型")).toBeInTheDocument();
    expect(screen.queryByText("已选模型已下线或暂无可用渠道，请明确选择其它模型后继续发送")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "消息内容" }), "新问题");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    expect(api.quote.mock.calls.at(-1)![0]).toMatchObject({ modelId: "replacement", conversationId: undefined, content: "新问题" });
});
