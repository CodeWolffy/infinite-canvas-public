import { create } from "zustand";

import { useUserStore } from "@/stores/use-user-store";

// 仅保留当前登录会话的未提交输入；离开工作台后可继续编辑，不写入浏览器存储。
const useWorkbenchDraftStore = create<{ drafts: Record<string, unknown> }>(() => ({ drafts: {} }));

export function getWorkbenchDraft<T>(key: string): T | undefined {
    return useWorkbenchDraftStore.getState().drafts[key] as T | undefined;
}

export function saveWorkbenchDraft<T>(key: string, value: T, sessionVersion: number) {
    if (useUserStore.getState().sessionVersion !== sessionVersion) return;
    useWorkbenchDraftStore.setState((state) => ({ drafts: { ...state.drafts, [key]: value } }));
}

export function clearWorkbenchDraft(key: string) {
    useWorkbenchDraftStore.setState((state) => {
        const drafts = { ...state.drafts };
        delete drafts[key];
        return { drafts };
    });
}

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion !== previous.sessionVersion) useWorkbenchDraftStore.setState({ drafts: {} });
});
