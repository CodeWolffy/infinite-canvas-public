import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AppErrorBoundary, AppErrorFallback } from "@/components/layout/app-error-boundary";

afterEach(cleanup);

function Boom(): never {
    throw new Error("渲染失败");
}

test("子组件渲染抛错时展示兜底页面与刷新入口", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
        <AppErrorBoundary>
            <Boom />
        </AppErrorBoundary>,
    );
    expect(screen.getByText("页面出现错误")).toBeTruthy();
    expect(screen.getByRole("button", { name: /刷新页面/ })).toBeTruthy();
    spy.mockRestore();
});

test("正常渲染时原样透传子节点", () => {
    render(
        <AppErrorBoundary>
            <span>页面内容</span>
        </AppErrorBoundary>,
    );
    expect(screen.getByText("页面内容")).toBeTruthy();
    expect(screen.queryByText("页面出现错误")).toBeNull();
});

test("路由错误页可展示自定义说明", () => {
    render(<AppErrorFallback message="路由加载失败" />);
    expect(screen.getByText("路由加载失败")).toBeTruthy();
});
