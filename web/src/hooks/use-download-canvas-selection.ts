import { useEffect, useRef, useState } from "react";
import { App } from "antd";

import { exportCanvasNodes } from "@/lib/canvas/canvas-export";
import { collectGroupMemberNodes } from "@/lib/canvas/canvas-node-geometry";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { CanvasNodeData } from "@/types/canvas";

export function useDownloadCanvasSelection() {
    const { message } = App.useApp();
    const [downloading, setDownloading] = useState(false);
    const busy = useRef(false);
    const mounted = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

    const downloadSelection = async (nodes: CanvasNodeData[], selectedIds: Iterable<string>) => {
        if (busy.current) return;
        const session = useUserStore.getState().sessionVersion;
        const targets = collectGroupMemberNodes(new Set(selectedIds), nodes);
        if (!targets.length) { message.info("选区内没有可下载内容，请选择图片、文本或其他内容节点。"); return; }
        busy.current = true;
        setDownloading(true);
        const hide = message.loading("正在打包选中内容…", 0);
        try {
            await exportCanvasNodes(targets, `选中内容-${targets.length}`);
            assertCurrentSession(session);
            if (mounted.current) message.success(`已下载 ${targets.length} 项选中内容`);
        } catch (error) {
            if (mounted.current && useUserStore.getState().sessionVersion === session && !(error instanceof Error && error.name === "AbortError")) message.error(`下载失败：${error instanceof Error ? error.message : "素材读取或打包失败，请重试"}`);
        } finally {
            hide();
            busy.current = false;
            if (mounted.current) setDownloading(false);
        }
    };

    return { downloading, downloadSelection };
}
