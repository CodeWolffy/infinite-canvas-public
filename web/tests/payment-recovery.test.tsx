import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PaymentOrder, PaymentOrderResult } from "@/services/api/billing";

const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), resume: vi.fn(), refresh: vi.fn(), wallet: vi.fn() }));
vi.mock("@/services/api/billing", () => ({ createPaymentOrder: api.create, getPaymentOrder: api.get, getPaymentOrders: api.list, resumePaymentOrder: api.resume, refreshPaymentOrder: api.refresh, getWallet: api.wallet, redeemCode: vi.fn(), paymentMethodLabels: { alipay: "支付宝", wxpay: "微信支付" } }));
vi.mock("@/services/api/platform-operations", () => ({ getReferrals: async () => ({ referrals: [], summary: { invited: 0, earned: "0" }, enabled: false }) }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => vi.fn() }));
vi.mock("antd", async (original) => ({ ...(await original<typeof import("antd")>()), QRCode: ({ value }: { value: string }) => <output aria-label="支付二维码">{value}</output> }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    return { useUserStore: create(() => ({ sessionVersion: 1, user: { id: "user-a" } })) };
});

import WalletPage from "@/pages/user/wallet";
import { useUserStore } from "@/stores/use-user-store";

const orders = new Map<string, PaymentOrder>();
const order = (id: string, patch: Partial<PaymentOrder> = {}): PaymentOrder => ({ id, userId: "user-a", channelId: "channel", method: "alipay", amount: "10.00", status: "pending", paymentUrl: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...patch } as PaymentOrder);
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
let client: QueryClient;
function mount(id?: string) {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    return render(<MemoryRouter initialEntries={[`/user/wallet${id ? `?order=${id}` : ""}`]}><QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }}><App><WalletPage /></App></ConfigProvider></QueryClientProvider></MemoryRouter>);
}
const paymentDialog = () => screen.getByRole("dialog", { name: "充值订单" });
async function openRechargeAndSubmit() {
    const user = userEvent.setup();
    const recharge = await screen.findByRole("button", { name: "充值余额" });
    await waitFor(() => expect(recharge).toBeEnabled());
    await user.click(recharge);
    const dialog = await screen.findByRole("dialog", { name: "充值余额" });
    await user.click(within(dialog).getAllByRole("combobox")[0]);
    await user.click(await screen.findByText("测试充值渠道", { selector: ".ant-select-item-option-content" }));
    await user.click(within(dialog).getByRole("button", { name: "创建充值订单" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
}
async function switchToB() {
    fireEvent.click(within(paymentDialog()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const buttons = screen.getAllByRole("button", { name: "查看订单" });
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(paymentDialog()).toHaveTextContent("order-b"));
}

beforeEach(() => {
    orders.clear(); orders.set("order-a", order("order-a")); orders.set("order-b", order("order-b", { amount: "20.00" }));
    useUserStore.setState({ sessionVersion: 1, user: { id: "user-a" } });
    api.wallet.mockReset().mockResolvedValue({ wallet: { balance: "0", frozen: "0" }, paymentChannels: [{ id: "channel", name: "测试充值渠道", methods: ["alipay"], provider: "epay" }] });
    api.list.mockReset().mockImplementation(async () => ({ orders: useUserStore.getState().sessionVersion === 1 ? [...orders.values()] : [] }));
    api.get.mockReset().mockImplementation(async (id) => { if (useUserStore.getState().sessionVersion !== 1) throw new Error("订单不存在"); return { order: orders.get(id)! }; });
    api.create.mockReset().mockResolvedValue({ order: orders.get("order-a"), paymentError: "支付渠道暂时不可用" });
    api.resume.mockReset(); api.refresh.mockReset();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("创建返回原订单和支付错误时进入订单，继续支付只恢复原编号并显示支付入口", async () => {
    api.resume.mockImplementation(async (id) => {
        const ready = order(id, { paymentUrl: "https://pay.example.test/order-a" });
        orders.set(id, ready);
        return { order: ready };
    });
    mount();
    await openRechargeAndSubmit();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "充值余额" })).not.toBeInTheDocument());
    expect(paymentDialog()).toHaveTextContent("order-a");
    expect(within(paymentDialog()).getByText("支付渠道暂时不可用")).toBeInTheDocument();
    fireEvent.click(within(paymentDialog()).getByRole("button", { name: "继续支付" }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledExactlyOnceWith("order-a", expect.anything()));
    const link = await within(paymentDialog()).findByRole("link", { name: "打开支付页面" });
    expect(link).toHaveAttribute("href", "https://pay.example.test/order-a");
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(within(paymentDialog()).queryByRole("button", { name: "继续支付" })).not.toBeInTheDocument();
});

test.each(["success", "payment-error", "reject"] as const)("恢复 A 后切到 B，A 的迟到 %s 不抢回订单或写入 B 的错误", async (mode) => {
    const pending = deferred<PaymentOrderResult>();
    api.resume.mockReturnValue(pending.promise);
    mount("order-a");
    fireEvent.click(await screen.findByRole("button", { name: "继续支付" }));
    await waitFor(() => expect(api.resume).toHaveBeenCalled());
    await switchToB();
    await act(async () => {
        if (mode === "reject") pending.reject(new Error("A 恢复失败"));
        else pending.resolve({ order: order("order-a", { paymentUrl: mode === "success" ? "https://pay.example.test/a-late" : null }), ...(mode === "payment-error" ? { paymentError: "A 支付入口错误" } : {}) });
    });
    expect(paymentDialog()).toHaveTextContent("order-b");
    expect(paymentDialog()).not.toHaveTextContent("order-a");
    expect(screen.queryByText("A 恢复失败")).not.toBeInTheDocument();
    expect(screen.queryByText("A 支付入口错误")).not.toBeInTheDocument();
    expect(within(paymentDialog()).queryByRole("link", { name: "打开支付页面" })).not.toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
});

test.each(["create", "resume", "refresh"] as const)("%s 期间换账号，迟到结果不展示旧订单", async (mode) => {
    const pending = deferred<PaymentOrderResult>();
    api[mode].mockReturnValue(pending.promise);
    mount(mode === "create" ? undefined : "order-a");
    if (mode === "create") await openRechargeAndSubmit();
    else {
        fireEvent.click(await screen.findByRole("button", { name: mode === "resume" ? "继续支付" : "我已支付，刷新状态" }));
        await waitFor(() => expect(api[mode]).toHaveBeenCalled());
    }
    act(() => useUserStore.setState({ sessionVersion: 2, user: { id: "user-b" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => pending.resolve({ order: order("order-a", { paymentUrl: "https://pay.example.test/old-account" }), paymentError: "旧账号支付错误" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("旧账号支付错误")).not.toBeInTheDocument();
    expect(client.getQueryData(["payment-order", 2, "order-a"])).toBeUndefined();
});

test.each(["create", "resume", "refresh"] as const)("%s 期间换账号，迟到错误不提示给当前账号", async (mode) => {
    const pending = deferred<PaymentOrderResult>();
    api[mode].mockReturnValue(pending.promise);
    mount(mode === "create" ? undefined : "order-a");
    if (mode === "create") await openRechargeAndSubmit();
    else {
        fireEvent.click(await screen.findByRole("button", { name: mode === "resume" ? "继续支付" : "我已支付，刷新状态" }));
        await waitFor(() => expect(api[mode]).toHaveBeenCalled());
    }
    act(() => useUserStore.setState({ sessionVersion: 2, user: { id: "user-b" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => pending.reject(new Error("旧账号操作失败")));
    expect(screen.queryByText("旧账号操作失败")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test.each(["success", "reject"] as const)("刷新 A 的状态期间切到 B，迟到 %s 只归原订单", async (mode) => {
    const pending = deferred<PaymentOrderResult>();
    api.refresh.mockReturnValue(pending.promise);
    mount("order-a");
    fireEvent.click(await screen.findByRole("button", { name: "我已支付，刷新状态" }));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith("order-a", expect.anything()));
    await switchToB();
    await act(async () => {
        if (mode === "reject") pending.reject(new Error("A 状态读取失败"));
        else pending.resolve({ order: order("order-a", { status: "paid" }) });
    });
    expect(paymentDialog()).toHaveTextContent("order-b");
    expect(paymentDialog()).not.toHaveTextContent("order-a");
    expect(screen.queryByText("A 状态读取失败")).not.toBeInTheDocument();
    expect(within(paymentDialog()).queryByText("充值成功，余额已到账")).not.toBeInTheDocument();
    expect((client.getQueryData(["payment-order", 1, "order-b"]) as PaymentOrderResult).order.status).toBe("pending");
    if (mode === "success") expect((client.getQueryData(["payment-order", 1, "order-a"]) as PaymentOrderResult).order.status).toBe("paid");
});

test.each(["reopen", "other-order"] as const)("创建 A 期间关闭充值并 %s，迟到结果不抢当前视图", async (mode) => {
    const pending = deferred<PaymentOrderResult>();
    api.create.mockReturnValue(pending.promise);
    mount();
    await openRechargeAndSubmit();
    fireEvent.click(within(screen.getByRole("dialog", { name: "充值余额" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    if (mode === "reopen") {
        fireEvent.click(screen.getByRole("button", { name: "充值余额" }));
        fireEvent.change(within(await screen.findByRole("dialog", { name: "充值余额" })).getByRole("spinbutton"), { target: { value: "25.00" } });
    } else {
        fireEvent.click(screen.getAllByRole("button", { name: "查看订单" })[1]);
        await waitFor(() => expect(paymentDialog()).toHaveTextContent("order-b"));
    }
    await act(async () => pending.resolve({ order: order("order-a"), paymentError: "A 支付渠道失败" }));
    if (mode === "reopen") {
        expect(screen.getByRole("dialog", { name: "充值余额" })).toBeInTheDocument();
        expect(screen.getByRole("spinbutton")).toHaveValue("25.00");
        expect(screen.queryByRole("dialog", { name: "充值订单" })).not.toBeInTheDocument();
    } else expect(paymentDialog()).toHaveTextContent("order-b");
    expect(screen.queryByText("A 支付渠道失败")).not.toBeInTheDocument();
    expect((client.getQueryData(["payment-order", 1, "order-a"]) as PaymentOrderResult).order.id).toBe("order-a");
    expect(api.create).toHaveBeenCalledTimes(1);
});

test.each(["paid", "expired", "closed"] as const)("%s 订单不提供继续支付入口", async (state) => {
    orders.set("order-a", order("order-a", state === "expired" ? { expiresAt: new Date(Date.now() - 1000).toISOString() } : { status: state }));
    mount("order-a");
    await waitFor(() => expect(paymentDialog()).toHaveTextContent("order-a"));
    expect(within(paymentDialog()).queryByRole("button", { name: "继续支付" })).not.toBeInTheDocument();
    expect(within(paymentDialog()).queryByRole("link", { name: "打开支付页面" })).not.toBeInTheDocument();
    expect(api.resume).not.toHaveBeenCalled();
    if (state === "paid") expect(within(paymentDialog()).getByText("充值成功，余额已到账")).toBeInTheDocument();
    if (state === "expired") expect(within(paymentDialog()).getByText("订单已过有效期，正在确认支付结果")).toBeInTheDocument();
});
