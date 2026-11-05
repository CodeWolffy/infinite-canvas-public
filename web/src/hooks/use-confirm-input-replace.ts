import { useEffect, useRef } from "react";
import { App } from "antd";

import { useUserStore } from "@/stores/use-user-store";

export function useConfirmInputReplace() {
    const { modal } = App.useApp();
    const mounted = useRef(false);
    const active = useRef<{ destroy: () => void; cancel: () => void } | null>(null);
    useEffect(() => {
        mounted.current = true;
        const unsubscribe = useUserStore.subscribe((state, previous) => {
            if (state.sessionVersion !== previous.sessionVersion) { active.current?.destroy(); active.current = null; }
        });
        return () => { active.current?.cancel(); active.current?.destroy(); active.current = null; mounted.current = false; unsubscribe(); };
    }, []);

    return (hasInput: boolean, onConfirm: () => void, onCancel?: () => void) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const current = () => mounted.current && useUserStore.getState().sessionVersion === sessionVersion;
        active.current?.cancel();
        active.current?.destroy();
        active.current = null;
        if (!hasInput) { if (current()) onConfirm(); return; }
        const cancel = () => { if (current()) onCancel?.(); };
        const dialog = modal.confirm({
            title: "替换未提交的创作输入？",
            content: "当前输入尚未提交，继续将替换它。取消可保留当前内容。",
            okText: "替换输入",
            cancelText: "保留当前输入",
            onOk: () => { active.current = null; if (current()) onConfirm(); },
            onCancel: () => { active.current = null; cancel(); },
        });
        active.current = { destroy: dialog.destroy, cancel };
    };
}
