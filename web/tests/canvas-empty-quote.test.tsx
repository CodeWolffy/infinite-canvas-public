import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

const quote = vi.hoisted(() => vi.fn());
vi.mock("@/services/api/platform-operations", () => ({ quoteGeneration: quote }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: (select: (value: { sessionVersion: number }) => unknown) => select({ sessionVersion: 1 }), assertCurrentSession: vi.fn() }));
const { useGenerationQuote } = await import("@/hooks/use-generation-quote");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
afterEach(() => { cleanup(); client.clear(); quote.mockReset(); });

test("普通空输入不报价，显式允许的仅参考视频保留真实空提示词报价", async () => {
    quote.mockResolvedValue({ quote: { estimatedHold: "0.8" } });
    const hook = renderHook(({ allowed }) => useGenerationQuote({ modelId: "video", count: 1, content: "", attachmentMediaIds: ["reference"] }, true, allowed), { initialProps: { allowed: false }, wrapper });
    expect(quote).not.toHaveBeenCalled();
    hook.rerender({ allowed: true });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(quote.mock.calls[0][0]).toMatchObject({ content: "", attachmentMediaIds: ["reference"] });
});

test("报价失败可沿用当前参数手动重试", async () => {
    quote.mockRejectedValueOnce(new Error("暂时不可用")).mockResolvedValueOnce({ quote: { estimatedHold: "0.4" } });
    const hook = renderHook(() => useGenerationQuote({ modelId: "image", count: 2, content: "森林" }), { wrapper });
    await waitFor(() => expect(hook.result.current.error?.message).toBe("暂时不可用"));
    await hook.result.current.refetch();
    await waitFor(() => expect(hook.result.current.quote?.estimatedHold).toBe("0.4"));
    expect(quote).toHaveBeenCalledTimes(2);
});

test("重复媒体只在报价传输去重，保留第一次出现的顺序", async () => {
    quote.mockResolvedValue({ quote: { estimatedHold: "0.2" } });
    const input = { modelId: "image", count: 1, content: "图1和图2是同一素材", attachmentMediaIds: ["first", "second", "FIRST"] };
    const hook = renderHook(() => useGenerationQuote(input), { wrapper });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(quote.mock.calls[0][0]).toMatchObject({ content: input.content, attachmentMediaIds: ["first", "second"] });
    expect(input.attachmentMediaIds).toEqual(["first", "second", "FIRST"]);
});
