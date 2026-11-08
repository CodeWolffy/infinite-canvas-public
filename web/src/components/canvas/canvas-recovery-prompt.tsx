import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal } from "antd";
import { RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export function CanvasRecoveryPrompt({ projectId }: { projectId: string }) {
    const { modal, message } = App.useApp();
    const navigate = useNavigate();
    const session = useUserStore((state) => state.sessionVersion);
    const recoveries = useCanvasStore((state) => state.recoveries[projectId]);
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const [selectedKey, setSelectedKey] = useState("");
    const [dismissed, setDismissed] = useState("");
    const [busy, setBusy] = useState(false);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const recovery = recoveries?.find((item) => item.key === selectedKey) || recoveries?.[0];
    if (!recovery || !project?.snapshotLoaded) return null;
    const scope = `${session}:${projectId}:${recovery.key}`;
    const canRestore = project.revision === recovery.baseRevision && project.accessRole !== "viewer" && project.accessRole !== "";
    const resolve = async (action: "restore" | "copy" | "discard") => {
        setBusy(true);
        try {
            const id = await useCanvasStore.getState().resolveRecovery(projectId, recovery.key, action);
            assertCurrentSession(session);
            if (!mounted.current) return;
            if (action === "copy") navigate(`/canvas/${id}`);
        } catch (error) {
            if (mounted.current && useUserStore.getState().sessionVersion === session) message.error(error instanceof Error ? error.message : "恢复失败，副本仍保留");
        } finally {
            if (mounted.current && useUserStore.getState().sessionVersion === session) setBusy(false);
        }
    };
    return <>
        <button type="button" onClick={() => setDismissed("")} className="flex h-6 shrink-0 items-center gap-1 rounded text-[10px] hover:bg-black/5 @min-[1024px]/canvas:h-8 @min-[1024px]/canvas:px-1 @min-[1024px]/canvas:text-xs dark:hover:bg-white/10"><RotateCcw className="size-3.5" />恢复未保存内容</button>
        <Modal open={dismissed !== scope} title="发现未保存的画布内容" onCancel={busy ? undefined : () => setDismissed(scope)} closable={!busy} mask={{ closable: !busy }} footer={[
            <Button key="later" disabled={busy} onClick={() => setDismissed(scope)}>稍后处理</Button>,
            <Button key="discard" danger disabled={busy} onClick={() => modal.confirm({ title: "丢弃这份恢复副本？", content: "只删除选中的浏览器副本，服务端画布和其他副本会保留。", okText: "丢弃副本", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => resolve("discard") })}>丢弃副本</Button>,
            <Button key="copy" loading={busy} onClick={() => void resolve("copy")}>另存恢复副本</Button>,
            <Button key="restore" type="primary" loading={busy} disabled={!canRestore} onClick={() => void resolve("restore")}>恢复到当前画布</Button>,
        ]}>
            <div className="space-y-4 py-3">
                <p>浏览器保留了尚未确认保存的编辑。当前显示服务端内容，选择恢复后才会继续保存。</p>
                {(recoveries?.length || 0) > 1 ? <div className="flex flex-wrap gap-2">{recoveries!.map((item, index) => <Button key={item.key} type={item.key === recovery.key ? "primary" : "text"} onClick={() => setSelectedKey(item.key)} disabled={busy}>副本 {index + 1}</Button>)}</div> : null}
                <div><p className="font-medium break-words">{recovery.title}</p><p className="mt-1 text-sm opacity-60">{new Date(recovery.savedAt).toLocaleString()} · 基于版本 {recovery.baseRevision}{recovery.snapshot ? ` · ${recovery.snapshot.nodes.length} 个节点` : " · 标题编辑"}</p></div>
                {!canRestore ? <Alert type="warning" title="远端版本或编辑权限已变化，请另存恢复副本。" /> : null}
            </div>
        </Modal>
    </>;
}
