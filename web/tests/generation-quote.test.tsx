import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { GenerationQuote } from "@/services/api/platform-operations";

const state = vi.hoisted(() => ({ sessionVersion: 1, quote: vi.fn() }));
vi.mock("@/services/api/platform-operations", () => ({ quoteGeneration: state.quote }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: (select: (value: { sessionVersion: number }) => unknown) => select(state),
    assertCurrentSession: (version: number) => { if (state.sessionVersion !== version) throw new DOMException("会话已变更", "AbortError"); },
}));

import { useGenerationQuote } from "@/hooks/use-generation-quote";

type Pending = { input: { content: string; parameters: Record<string, unknown> }; signal: AbortSignal; resolve: (value: { quote: GenerationQuote }) => void };
let pending: Pending[];
let client: QueryClient;
const response = (amount: string) => ({ quote: { pricingKind: "fixed", estimatedHold: amount, unitHold: amount, seconds: null, groupDiscount: "1", variable: false } as GenerationQuote });

beforeEach(() => {
    state.sessionVersion = 1;
    pending = [];
    state.quote.mockReset().mockImplementation((input, signal) => new Promise((resolve) => pending.push({ input, signal, resolve })));
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });

function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }

test("参数变化后中止旧报价，较晚返回的旧费用不能覆盖新费用", async () => {
    const hook = renderHook(({ size }) => useGenerationQuote({ modelId: "image", count: 2, content: "画一棵树", parameters: { size } }), { initialProps: { size: "1024x1024" }, wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));
    hook.rerender({ size: "2048x2048" });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal.aborted).toBe(true);
    await act(async () => pending[1].resolve(response("0.4")));
    await waitFor(() => expect(hook.result.current.quote?.estimatedHold).toBe("0.4"));
    await act(async () => pending[0].resolve(response("99")));
    expect(hook.result.current.quote?.estimatedHold).toBe("0.4");
});

test("切换会话后重新报价，旧会话的结果不进入当前状态", async () => {
    const hook = renderHook(() => useGenerationQuote({ modelId: "image", count: 1, content: "画一棵树", parameters: {} }), { wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));
    state.sessionVersion = 2;
    hook.rerender();
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal.aborted).toBe(true);
    await act(async () => pending[0].resolve(response("99")));
    expect(hook.result.current.quote).toBeUndefined();
    await act(async () => pending[1].resolve(response("0.2")));
    await waitFor(() => expect(hook.result.current.quote?.estimatedHold).toBe("0.2"));
});
