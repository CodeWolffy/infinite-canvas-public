import { beforeEach, expect, test, vi } from "vitest";
vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    return { useUserStore: create(() => ({ sessionVersion: 1, user: { id: "user" } })) };
});
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasHandoffStore } from "@/stores/canvas/use-canvas-handoff-store";
import { getWorkbenchDraft, saveWorkbenchDraft } from "@/stores/use-workbench-draft-store";

beforeEach(() => { useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 })); });
test("画布交接仅匹配目标消费一次，迟到旧交接不能清除新交接", () => {
    const store = useCanvasHandoffStore.getState();
    store.open([{ kind: "text", title: "文案", content: "内容" }], "origin");
    const id = useCanvasHandoffStore.getState().request!.id;
    store.target(id, "canvas");
    expect(store.consume(id, "another")).toBeNull();
    expect(store.consume(id, "canvas")?.items).toHaveLength(1);
    expect(store.consume(id, "canvas")).toBeNull();
    store.open([{ kind: "text", title: "新文案", content: "新内容" }], "origin");
    store.cancel(id);
    expect(useCanvasHandoffStore.getState().request?.items[0].title).toBe("新文案");
});
test("切换账号清除交接和未提交草稿，旧会话不能写回", () => {
    const session = useUserStore.getState().sessionVersion;
    saveWorkbenchDraft("image", { prompt: "旧账号" }, session);
    useCanvasHandoffStore.getState().open([{ kind: "text", title: "文案", content: "内容" }], "origin");
    useUserStore.setState({ sessionVersion: session + 1 });
    saveWorkbenchDraft("image", { prompt: "迟到" }, session);
    expect(getWorkbenchDraft("image")).toBeUndefined();
    expect(useCanvasHandoffStore.getState().request).toBeNull();
});
