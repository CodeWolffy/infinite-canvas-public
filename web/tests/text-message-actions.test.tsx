import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TextMessage } from "@/services/api/text";

const actions = vi.hoisted(() => ({ sessionVersion: 1, addToCanvas: vi.fn(), copy: vi.fn(), addAsset: vi.fn(), draft: vi.fn(), download: vi.fn() }));
vi.mock("@/hooks/use-add-to-canvas", () => ({ useAddToCanvas: () => actions.addToCanvas }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => actions.copy }));
vi.mock("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ addAsset: actions.addAsset }) } }));
vi.mock("@/stores/use-creation-draft-store", () => ({ useCreationDraftStore: { getState: () => ({ setDraft: actions.draft }) } }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: Object.assign((selector: (state: typeof actions) => unknown) => selector(actions), { getState: () => actions }),
    assertCurrentSession: (session: number) => { if (session !== actions.sessionVersion) throw new DOMException("会话已改变", "AbortError"); },
}));
vi.mock("file-saver", () => ({ saveAs: actions.download }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
import { TextMessageRow } from "@/pages/text/text-message";

const item: TextMessage = { id: "answer", role: "assistant", content: "前文 目标片段 后文", createdAt: "2026-01-01", requestId: "request", requestMessageId: "question", modelDisplayName: "文本模型", billed: "0.01", finishReason: "length" };
let client: QueryClient;
function mount(messages = [item], canContinue = true) {
    const onEdit = vi.fn(), onRegenerate = vi.fn(), onContinue = vi.fn();
    client = new QueryClient();
    const tree = () => <QueryClientProvider client={client}><App><MemoryRouter>{messages.map((message) => <TextMessageRow key={message.id} item={message} disabled={false} canContinue={canContinue} onEdit={onEdit} onRegenerate={onRegenerate} onContinue={onContinue} />)}</MemoryRouter></App></QueryClientProvider>;
    const view = render(tree());
    return { ...view, onEdit, onRegenerate, onContinue, refresh: () => view.rerender(tree()) };
}
function select(start: Node, startOffset: number, end = start, endOffset = start.textContent!.length) {
    const range = document.createRange();
    range.setStart(start, startOffset); range.setEnd(end, endOffset);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    fireEvent(document, new Event("selectionchange"));
}
beforeEach(() => {
    actions.sessionVersion++;
    actions.addToCanvas.mockReset(); actions.copy.mockReset(); actions.addAsset.mockReset().mockResolvedValue("asset"); actions.draft.mockReset(); actions.download.mockReset();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); client?.clear(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("回复展示模型与费用，重新生成/继续写回调只针对当前消息，历史版本只读", async () => {
    const view = mount([item, { ...item, id: "older", content: "旧版本", supersededAt: "2026-02-01" }]);
    expect(screen.getAllByText("文本模型 · ¥0.01")).toHaveLength(2);
    expect(screen.getByText("历史版本")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重新生成回复" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "重新生成回复" }));
    await userEvent.click(screen.getByRole("button", { name: "继续写" }));
    expect(view.onRegenerate).toHaveBeenCalledWith(item);
    expect(view.onContinue).toHaveBeenCalledWith(item);
    expect(document.getElementById("text-message-answer")).toBeInTheDocument();
});

test("非最新有效回复只显示达到上限的提示，搜索目标可获得焦点", () => {
    mount([item], false);
    expect(screen.getByText("回复达到本次输出上限。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续写" })).not.toBeInTheDocument();
    const target = document.getElementById("text-message-answer")!;
    target.focus();
    expect(target).toHaveFocus();
});

test("选择同一消息的片段后打开菜单，即使选区消失也只交接该片段", async () => {
    mount();
    select(screen.getByText(item.content).firstChild!, 3, undefined, 7);
    await userEvent.click(await screen.findByRole("button", { name: "使用选中文字" }));
    await screen.findByText("加入画布");
    act(() => { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); });
    await userEvent.click(screen.getByText("加入画布"));
    expect(actions.addToCanvas).toHaveBeenCalledWith([{ kind: "text", content: "目标片段", title: "目标片段" }]);
});

test("跨消息选区不出现片段操作，不会误用任意一条整文", () => {
    mount([item, { ...item, id: "second", content: "第二条回复" }]);
    select(screen.getByText(item.content).firstChild!, 3, screen.getByText("第二条回复").firstChild!, 4);
    expect(screen.queryByRole("button", { name: "使用选中文字" })).not.toBeInTheDocument();
    expect(actions.addToCanvas).not.toHaveBeenCalled();
});

test("保存素材先让用户确认标题，以 private 创建且保留完整内容", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "更多回复操作" }));
    await user.click(await screen.findByText("存为文本素材"));
    expect(actions.addAsset).not.toHaveBeenCalled();
    const title = screen.getByRole("textbox", { name: "素材标题" });
    await user.clear(title); await user.type(title, "我的摘录");
    await user.click(screen.getByRole("button", { name: "保 存" }));
    await waitFor(() => expect(actions.addAsset).toHaveBeenCalledWith(expect.objectContaining({ scope: "private", title: "我的摘录", data: { content: item.content } })));
});

test("保存弹窗打开后切换会话关闭旧弹窗，迟到确认不创建旧账号内容", async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "更多回复操作" }));
    await user.click(await screen.findByText("存为文本素材"));
    const confirm = screen.getByRole("button", { name: "保 存" });
    act(() => { actions.sessionVersion++; view.refresh(); });
    fireEvent.click(confirm);
    expect(actions.addAsset).not.toHaveBeenCalled();
});
