import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TextRequestDetail, TextRequestState } from "@/services/api/text";

const api = vi.hoisted(() => ({ cancel: vi.fn(), watch: vi.fn(), conversation: vi.fn() }));
vi.mock("@/services/api/generation", () => ({ getPublicModels: async () => [{ id: "model", name: "model", displayName: "文本模型", capability: "text", price: "0.1" }] }));
vi.mock("@/services/api/billing", () => ({ getWallet: async () => ({ wallet: { balance: "10" } }) }));
vi.mock("@/services/api/platform-operations", () => ({ quoteGeneration: vi.fn() }));
vi.mock("@/services/api/tasks", () => ({ cancelGenerationTask: api.cancel }));
vi.mock("@/services/api/text", () => ({ getTextConversation: api.conversation, listTextConversations: async () => [], queueTextRequest: vi.fn(), watchTextRequest: api.watch, deleteTextConversation: vi.fn() }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: Object.assign((select: (value: { sessionVersion: number }) => unknown) => select({ sessionVersion: 1 }), { getState: () => ({ sessionVersion: 1 }) }),
    assertCurrentSession: vi.fn(),
}));
vi.mock("@/components/layout/app-providers", () => ({ queryClient: {} }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
import TextPage from "@/pages/text";

let client: QueryClient;
let publish: (detail: TextRequestDetail) => void;
const request = (canCancel: boolean, status: TextRequestState["status"] = "running"): TextRequestState => ({ id: "request", conversationId: "history", responseMessageId: null, status, canCancel, errorCode: null, createdAt: "2026-01-01", finishedAt: null, run: 1, streamSequence: 0 });

function mount(latest: TextRequestState) {
    api.conversation.mockResolvedValue({ conversation: { id: "history", title: "对话", modelId: "model", canvasProjectId: null }, messages: [], latestRequest: latest });
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><App><MemoryRouter initialEntries={["/text?conversation=history"]}><TextPage /></MemoryRouter></App></QueryClientProvider>);
}

beforeEach(() => {
    api.cancel.mockReset().mockResolvedValue(undefined);
    api.watch.mockReset().mockImplementation((_id, onChange) => { publish = onChange; return () => undefined; });
    api.conversation.mockReset();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.each(["queued", "running"] as const)("已提交任务即使处于 %s 也禁止前端取消", async (status) => {
    mount(request(false, status));
    const cancel = await screen.findByRole("button", { name: "取消生成" });
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveAttribute("title", "已提交上游，无法取消");
    await userEvent.click(cancel);
    expect(api.cancel).not.toHaveBeenCalled();
});

test("收到提交快照后立即禁止取消，不依赖新的文本或状态变化", async () => {
    mount(request(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "取消生成" })).toBeEnabled());
    act(() => publish({ request: request(false), message: null }));
    await waitFor(() => expect(screen.getByRole("button", { name: "取消生成" })).toBeDisabled());
    expect(screen.getByText("已提交上游，继续生成并正常结算")).toBeInTheDocument();
    expect(api.cancel).not.toHaveBeenCalled();
});

test("尚未提交时可以发起取消", async () => {
    mount(request(true, "queued"));
    const cancel = await screen.findByRole("button", { name: "取消生成" });
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("request"));
});
