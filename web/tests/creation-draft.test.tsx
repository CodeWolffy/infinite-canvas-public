import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/stores/use-user-store", async () => {
    const { create } = await import("zustand");
    return { useUserStore: create(() => ({ sessionVersion: 1 })) };
});

import { usePromptCreation } from "@/hooks/use-prompt-creation";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import { useUserStore } from "@/stores/use-user-store";
import type { Prompt } from "@/services/api/prompts";

afterEach(() => {
    cleanup();
    useCreationDraftStore.getState().clearDraft();
});

test("从示例进入工作台时保留模型与参数，展示图不被误当成参考输入", () => {
    const prompt: Prompt = {
        id: "sample", sourceId: "library", title: "商品摄影", prompt: "保留产品的颜色与结构", description: "",
        coverUrl: "https://example.test/result.png", referenceImageUrls: ["https://example.test/result.png"],
        tags: [], preview: "", createdAt: "", updatedAt: "", category: "商品", githubUrl: "",
        imageModel: "source-model", imageSize: "1536x1024", imageCount: 2,
    };
    function Starter() {
        const start = usePromptCreation();
        return <button onClick={() => start(prompt)}>用此创作</button>;
    }
    render(<MemoryRouter initialEntries={["/prompts"]}><Routes><Route path="/prompts" element={<Starter />} /><Route path="/image" element={<p>图片工作台</p>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "用此创作" }));
    expect(screen.getByText("图片工作台")).toBeInTheDocument();
    expect(useCreationDraftStore.getState().draft).toMatchObject({ capability: "image", prompt: prompt.prompt, modelName: "source-model", settings: { size: "1536x1024", count: "2" }, sessionVersion: useUserStore.getState().sessionVersion });
    expect(useCreationDraftStore.getState().draft?.references).toBeUndefined();
});

test("较早的交接完成不能清除新草稿，切换登录会话会清理未消费草稿", () => {
    const store = useCreationDraftStore.getState();
    store.setDraft({ capability: "image", prompt: "第一份" });
    const previousId = useCreationDraftStore.getState().draft!.id;
    store.setDraft({ capability: "video", prompt: "第二份" });
    store.clearDraft(previousId);
    expect(useCreationDraftStore.getState().draft?.prompt).toBe("第二份");
    useUserStore.setState((state) => ({ sessionVersion: state.sessionVersion + 1 }));
    expect(useCreationDraftStore.getState().draft).toBeNull();
});
