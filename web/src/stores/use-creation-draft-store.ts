import { create } from "zustand";

import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export type CreationDraftInput = {
    capability: "image" | "video" | "text";
    prompt: string;
    modelId?: string;
    modelName?: string;
    settings?: Partial<Pick<AiConfig, "size" | "quality" | "count" | "background" | "videoSeconds" | "vquality" | "videoMode">>;
    references?: ReferenceImage[];
    sourceTitle?: string;
};

export type CreationDraft = CreationDraftInput & { id: string; sessionVersion: number };

type CreationDraftStore = {
    draft: CreationDraft | null;
    setDraft: (input: CreationDraftInput) => void;
    clearDraft: (id?: string) => void;
};

// 跨页面交接只保存在当前登录会话的内存中，不写入 URL 或浏览器持久化存储。
export const useCreationDraftStore = create<CreationDraftStore>()((set) => ({
    draft: null,
    setDraft: (input) => set({ draft: { ...input, id: crypto.randomUUID(), sessionVersion: useUserStore.getState().sessionVersion } }),
    clearDraft: (id) => set((state) => !id || state.draft?.id === id ? { draft: null } : state),
}));

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion !== previous.sessionVersion) useCreationDraftStore.getState().clearDraft();
});
