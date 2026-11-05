import { create } from "zustand";
import { nanoid } from "nanoid";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { useUserStore } from "@/stores/use-user-store";

type CanvasHandoff = {
    id: string;
    sessionVersion: number;
    sourceLocationKey: string;
    projectId: string | null;
    items: InsertAssetPayload[];
};

type CanvasHandoffStore = {
    request: CanvasHandoff | null;
    open: (items: InsertAssetPayload[], sourceLocationKey: string) => void;
    target: (id: string, projectId: string) => boolean;
    isCurrent: (id: string) => boolean;
    consume: (id: string, projectId: string) => CanvasHandoff | null;
    cancel: (id?: string) => void;
};

// 只保存当前登录会话的一次交接；刷新、取消、离开目标页面都不会重放素材。
export const useCanvasHandoffStore = create<CanvasHandoffStore>()((set, get) => ({
    request: null,
    open: (items, sourceLocationKey) => {
        const { user, sessionVersion } = useUserStore.getState();
        if (!user || !items.length) return;
        set({ request: { id: nanoid(), sessionVersion, sourceLocationKey, projectId: null, items: items.map((item) => ({ ...item })) } });
    },
    isCurrent: (id) => get().request?.id === id && get().request?.sessionVersion === useUserStore.getState().sessionVersion,
    target: (id, projectId) => {
        if (!get().isCurrent(id)) return false;
        set({ request: { ...get().request!, projectId } });
        return true;
    },
    consume: (id, projectId) => {
        const request = get().request;
        if (!get().isCurrent(id) || request?.projectId !== projectId) return null;
        set({ request: null });
        return request;
    },
    cancel: (id) => {
        if (!id || get().request?.id === id) set({ request: null });
    },
}));

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion !== previous.sessionVersion) useCanvasHandoffStore.getState().cancel();
});
