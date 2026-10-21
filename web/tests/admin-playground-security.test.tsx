import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ proof: vi.fn(), run: vi.fn() }));
vi.mock("@/hooks/use-security-proof", () => ({ useSecurityProof: () => ({ requestProof: api.proof }) }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("@/services/api/admin-platform", () => ({
    getAdminChannels: async () => [{ id: "channel", name: "测试渠道", capability: "text", protocol: "openai", status: "active", baseUrl: "https://example.invalid", upstreamModels: ["test-model"] }],
    testChannelPlayground: api.run,
}));
import AdminPlaygroundPage from "@/pages/admin/playground";

let client: QueryClient;
beforeEach(() => {
    api.proof.mockReset();
    api.run.mockReset().mockResolvedValue({ ok: true, durationMs: 1, text: "测试结果" });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function startProbe() {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><App><AdminPlaygroundPage /></App></QueryClientProvider>);
    await userEvent.click(screen.getByRole("combobox", { name: "目标渠道" }));
    await userEvent.click(await screen.findByText("测试渠道"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "上游模型 (Model ID)" })).toHaveValue("test-model"));
    await userEvent.click(screen.getByRole("button", { name: "发送测试请求" }));
    await waitFor(() => expect(api.proof).toHaveBeenCalledOnce());
}

test("调试等待二次验证，只有通过后才发送凭据与测试请求", async () => {
    let approve!: (proof: { password: string }) => void;
    api.proof.mockImplementation(() => new Promise((resolve) => { approve = resolve; }));
    await startProbe();
    expect(api.run).not.toHaveBeenCalled();
    act(() => approve({ password: "test-password" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledOnce());
    expect(api.run).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel", model: "test-model" }), { password: "test-password" }, expect.any(AbortSignal));
    expect(await screen.findByText("测试结果")).toBeInTheDocument();
});

test("取消二次验证后不产生调试请求", async () => {
    api.proof.mockRejectedValue(new Error("已取消安全验证"));
    await startProbe();
    expect(await screen.findByText("已取消安全验证")).toBeInTheDocument();
    expect(api.run).not.toHaveBeenCalled();
});

test("离开调试页后确认旧弹窗也不会向上游发请求", async () => {
    let approve!: (proof: { password: string }) => void;
    api.proof.mockImplementation(() => new Promise((resolve) => { approve = resolve; }));
    await startProbe();
    cleanup();
    act(() => approve({ password: "test-password" }));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(api.run).not.toHaveBeenCalled();
});
