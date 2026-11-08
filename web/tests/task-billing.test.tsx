import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider } from "antd";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TaskBilling, TaskBillingAttempt } from "@/services/api/task-billing";
import type { TaskCancellation } from "@/services/api/tasks";

const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/services/api/task-billing", () => ({ getTaskBilling: api.read }));
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    return { useUserStore: create(() => ({ sessionVersion: 1 })) };
});
import { TaskBillingButton } from "@/components/generation/task-billing-button";
import { useUserStore } from "@/stores/use-user-store";
import { taskCancellationMessage } from "@/lib/task-cancellation";

const clients: QueryClient[] = [];
const attempt = (patch: Partial<TaskBillingAttempt> = {}): TaskBillingAttempt => ({ run: 1, estimated: "0.100000", charged: null, refunded: "0.000000", additional: "0.000000", settled: false, createdAt: "", updatedAt: "", ...patch });
const record = (current = attempt(), patch: Partial<TaskBilling> = {}): TaskBilling => ({ taskId: "task", status: "running", current, attempts: [current], totalCharged: "0.000000", ...patch });
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    clients.push(client);
    return render(<ConfigProvider theme={{ token: { motion: false } }}><QueryClientProvider client={client}><TaskBillingButton taskId="task" /></QueryClientProvider></ConfigProvider>);
}
async function open() {
    await userEvent.click(screen.getByRole("button", { name: "费用详情" }));
    return screen.findByLabelText("生成费用详情");
}
beforeEach(() => {
    api.read.mockReset(); useUserStore.setState({ sessionVersion: 1 });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("费用按点击读取，生成中使用预计金额且保留微元精度", async () => {
    api.read.mockResolvedValue(record(attempt({ estimated: "0.000001" })));
    mount(); expect(api.read).not.toHaveBeenCalled();
    const panel = await open();
    expect(await within(panel).findByText("预计消费")).toBeInTheDocument();
    expect(within(panel).getByText("¥0.000001")).toBeInTheDocument();
    expect(within(panel).queryByText("¥0")).not.toBeInTheDocument();
    expect(within(panel).queryByText("本次消费")).not.toBeInTheDocument();
    expect(api.read).toHaveBeenCalledOnce();
    expect(api.read.mock.calls[0][0]).toBe("task");
    expect(api.read.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
});

test("结算后显示实际消费和退回余额", async () => {
    api.read.mockResolvedValue(record(attempt({ settled: true, charged: "0.075000", refunded: "0.025000" }), { status: "succeeded", totalCharged: "0.075000" }));
    mount(); const panel = await open();
    expect(await within(panel).findByText("本次消费")).toBeInTheDocument();
    expect(within(panel).getByText("¥0.075")).toBeInTheDocument();
    expect(within(panel).getByText("退回余额")).toBeInTheDocument();
    expect(within(panel).getByText("¥0.025")).toBeInTheDocument();
    expect(within(panel).queryByText("预计消费")).not.toBeInTheDocument();
});

test("追加费用仅说明已计入本次消费，不再次累加到消费金额", async () => {
    api.read.mockResolvedValue(record(attempt({ settled: true, estimated: "1.000000", charged: "1.200001", additional: "0.200001" }), { status: "succeeded", totalCharged: "1.200001" }));
    mount(); const panel = await open();
    expect(await within(panel).findByText("¥1.200001")).toBeInTheDocument();
    expect(within(panel).getByText("实际用量超过预计，余额另扣 ¥0.200001，已计入本次消费。")).toBeInTheDocument();
    expect(within(panel).queryByText("¥1.400002")).not.toBeInTheDocument();
    expect(within(panel).queryByText("退回余额")).not.toBeInTheDocument();
});

test("生成中缺少预计金额时显示未知而不是零", async () => {
    api.read.mockResolvedValue(record(attempt({ estimated: "" })));
    mount(); const panel = await open();
    expect(await within(panel).findByText("预计消费")).toBeInTheDocument();
    expect(within(panel).getByText("—")).toBeInTheDocument();
    expect(within(panel).queryByText("¥0")).not.toBeInTheDocument();
});

test("历史重试默认折叠，展开后仅列先前尝试和累计消费", async () => {
    const first = attempt({ settled: true, charged: "0.000000", refunded: "0.100000" });
    const current = attempt({ run: 2, settled: true, charged: "0.075000", refunded: "0.025000" });
    api.read.mockResolvedValue(record(current, { attempts: [first, current], totalCharged: "0.075000" }));
    mount(); const panel = await open();
    const summary = await within(panel).findByText("历史重试 · 累计消费 ¥0.075");
    const history = summary.closest("details")!;
    expect(history.open).toBe(false);
    await userEvent.click(summary);
    expect(history.open).toBe(true);
    expect(within(history).getByText("首次生成")).toBeInTheDocument();
    expect(within(history).getByText("消费 ¥0 · 退回 ¥0.1")).toBeInTheDocument();
    expect(within(history).queryByText("第 1 次重试")).not.toBeInTheDocument();
});

test("已结算但金额未知时显示未知，不能声称本次未收费", async () => {
    api.read.mockResolvedValue(record(attempt({ settled: true, charged: null })));
    mount(); const panel = await open();
    expect(await within(panel).findByText("本次消费")).toBeInTheDocument();
    expect(within(panel).getByText("—")).toBeInTheDocument();
    expect(within(panel).queryByText("本次未收费。")).not.toBeInTheDocument();
    expect(within(panel).queryByText("¥0")).not.toBeInTheDocument();
});

test("没有费用记录时给出未知提示，读取失败可以刷新重试", async () => {
    api.read.mockResolvedValueOnce(record(attempt(), { current: null, attempts: [] })).mockRejectedValueOnce(new Error("失败")).mockResolvedValue(record(attempt({ settled: true, charged: "0.000000" })));
    mount(); const panel = await open();
    expect(await within(panel).findByText("该任务暂无可核对的费用记录。")).toBeInTheDocument();
    expect(within(panel).queryByText("¥0")).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "刷新" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("费用暂时无法读取，请刷新重试。");
    await userEvent.click(within(panel).getByRole("button", { name: "刷新" }));
    expect(await within(panel).findByText("本次未收费。")).toBeInTheDocument();
    expect(api.read).toHaveBeenCalledTimes(3);
});

test("切换账号立即关闭弹层，新会话点击前不请求，也不展示旧记录", async () => {
    api.read.mockResolvedValueOnce(record(attempt({ settled: true, charged: "88.123456" }))).mockResolvedValue(record(attempt({ estimated: "0.000009" })));
    mount(); await open(); await screen.findByText("¥88.123456");
    act(() => useUserStore.setState({ sessionVersion: 2 }));
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(api.read).toHaveBeenCalledOnce();
    expect(screen.queryByText("¥88.123456")).not.toBeInTheDocument();
    const panel = await open();
    expect(await within(panel).findByText("¥0.000009")).toBeInTheDocument();
    expect(within(panel).queryByText("¥88.123456")).not.toBeInTheDocument();
    expect(api.read).toHaveBeenCalledTimes(2);
});

test("旧账号的迟到费用响应不能进入重新打开的新会话弹层", async () => {
    let finish!: (value: TaskBilling) => void;
    api.read.mockReturnValueOnce(new Promise<TaskBilling>((resolve) => { finish = resolve; })).mockResolvedValue(record(attempt({ estimated: "0.000008" })));
    mount(); await open(); await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
    act(() => useUserStore.setState({ sessionVersion: 2 }));
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    const panel = await open(); await within(panel).findByText("¥0.000008");
    await act(async () => finish(record(attempt({ settled: true, charged: "999.123456" }))));
    expect(within(panel).queryByText("¥999.123456")).not.toBeInTheDocument();
    expect(within(panel).getByText("¥0.000008")).toBeInTheDocument();
});

test.each<[TaskCancellation, string]>([
    [{ canceled: true, status: "canceled", refunded: "0.000001" }, "任务已取消，已退回 ¥0.000001"],
    [{ canceled: true, status: "canceled", refunded: "0.000000" }, "任务已取消，本次未收费"],
    [{ canceled: false, status: "succeeded", refunded: "0.000000" }, "任务已完成，未执行取消"],
    [{ canceled: false, status: "failed", refunded: "0.000000" }, "任务已失败，无需取消"],
    [{ canceled: false, status: "canceled", refunded: "0.000000" }, "任务此前已取消"],
    [{ canceled: false, status: "running", refunded: "0.000000" }, "任务状态已变化，请刷新查看"],
])("取消提示依据服务端真实结果 %j", (result, expected) => expect(taskCancellationMessage(result)).toBe(expected));
