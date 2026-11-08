import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import dayjs from "dayjs";
import ts from "typescript";
import { evaluate, findNode, sourceFile } from "./support/source-loader";
import { formatMoney } from "@/lib/format-money";

const state = vi.hoisted(() => ({ session: 1, read: vi.fn() }));
vi.mock("@/services/api/admin-users", () => ({ getAdminUsersPage: state.read }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: (select: (value: unknown) => unknown) => select({ sessionVersion: state.session }) }));
vi.mock("antd", () => ({
    Select: ({ showSearch, options, popupRender, onChange }: any) => <div><input aria-label="搜索用户" onChange={(event) => showSearch.onSearch(event.target.value)} />{popupRender(<div>{options.map((item: any) => <button key={item.value} onClick={() => onChange(item.value, item)}>{item.label}</button>)}</div>)}</div>,
    Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>, Spin: () => <span>加载中</span>,
}));
const { AdminUserSelect } = await import("@/pages/admin/components/admin-user-select");
afterEach(() => { cleanup(); state.read.mockReset(); vi.useRealTimers(); });

test("后台用户选择服务端分页加载并对全量用户远程搜索", async () => {
    state.read.mockImplementation(async ({ page, keyword }) => keyword ? { users: [{ id: "older", displayName: "旧用户", username: keyword }], total: 1 } : { users: [{ id: `user-${page}`, displayName: `用户${page}`, username: `u${page}` }], total: 2 });
    const changed = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AdminUserSelect onChange={changed} /></QueryClientProvider>);
    expect(await screen.findByText("用户1 · u1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("加载更多用户"));
    expect(await screen.findByText("用户2 · u2")).toBeInTheDocument();
    expect(state.read).toHaveBeenCalledWith({ page: 2, size: 200, keyword: "" });
    fireEvent.change(screen.getByLabelText("搜索用户"), { target: { value: "previous" } });
    fireEvent.click(await screen.findByText("旧用户 · previous"));
    expect(changed).toHaveBeenCalledWith("older", expect.objectContaining({ label: "旧用户 · previous" }));
    expect(state.read).toHaveBeenLastCalledWith({ page: 1, size: 200, keyword: "previous" });
    await waitFor(() => expect(screen.queryByText("用户1 · u1")).not.toBeInTheDocument());
});

function logQuery(preset: number | null, run: (input: any) => void) {
    const source = sourceFile("pages/admin/logs/index.tsx", ts.ScriptKind.TSX);
    const property = findNode(source, (node) => ts.isPropertyAssignment(node) && node.name.getText(source) === "queryFn" && node.initializer.getText(source).includes("getAdminRequestLogs")) as ts.PropertyAssignment;
    return evaluate(property.initializer.getText(source), { dayjs, preset, getAdminRequestLogs: run, page: 1, pageSize: 20, filters: { range: [dayjs("2026-11-01T00:00:00"), dayjs("2026-11-01T12:00:00")] } }) as () => void;
}

test("今天每次刷新使用新的截止时间，自定义范围保持原值", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
    const read = vi.fn(), refresh = logQuery(1, read);
    refresh(); const first = read.mock.calls[0][0];
    vi.setSystemTime(new Date("2026-11-08T11:00:00Z")); refresh();
    expect(read.mock.calls[1][0].to).toBe("2026-11-08T11:00:00.000Z");
    expect(read.mock.calls[1][0].to).not.toBe(first.to);
    const custom = logQuery(null, read); custom();
    const chosen = read.mock.calls[2][0];
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z")); custom();
    expect(read.mock.calls[3][0]).toEqual(chosen);
});

test.each([
    ["0.000001", "¥0.000001"], ["0.010000", "¥0.01"], ["1234567890123.123456", "¥1234567890123.123456"],
    ["0.000000", "¥0"], ["-1.500000", "¥-1.5"], [null, "—"], [undefined, "—"], ["", "—"], ["invalid", "—"], [0.000001, "¥0.000001"],
])("费用按有效小数展示 %s", (input, expected) => expect(formatMoney(input)).toBe(expected));
