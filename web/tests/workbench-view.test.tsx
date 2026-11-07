import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useWorkbenchView } from "@/hooks/use-workbench-view";

afterEach(cleanup);

test("提交成功才切换到结果，提交期间保持创作视图", () => {
    const { result } = renderHook(() => useWorkbenchView("create"));
    const showResults = result.current.captureResultView();
    expect(result.current.view).toBe("create");
    act(showResults);
    expect(result.current.view).toBe("results");
});

test("提交后继续编辑时，迟到成功不会切走创作视图", () => {
    const { result } = renderHook(() => useWorkbenchView("create"));
    const showResults = result.current.captureResultView();
    act(() => result.current.markInteraction());
    act(showResults);
    expect(result.current.view).toBe("create");
});

test("主动进入结果再继续调整后，旧提交不能重新切换视图", () => {
    const { result } = renderHook(() => useWorkbenchView("create"));
    const showResults = result.current.captureResultView();
    act(() => result.current.selectView("results"));
    act(() => result.current.selectView("create"));
    act(showResults);
    expect(result.current.view).toBe("create");
});

test("视图在重新渲染时保留，新的提交可以正常进入结果", () => {
    const { result, rerender } = renderHook(({ initialView }) => useWorkbenchView(initialView), { initialProps: { initialView: "results" as "create" | "results" } });
    act(() => result.current.selectView("create"));
    rerender({ initialView: "results" });
    expect(result.current.view).toBe("create");
    const showResults = result.current.captureResultView();
    act(showResults);
    expect(result.current.view).toBe("results");
});
