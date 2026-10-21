import { useState } from "react";
import { Alert, App, Button, Modal, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getCanvasProject } from "@/services/api/canvas-projects";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function CanvasSaveConflictModal({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
    const { modal, message } = App.useApp();
    const navigate = useNavigate();
    const session = useUserStore((state) => state.sessionVersion);
    const local = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const [busy, setBusy] = useState(false);
    const remote = useQuery({ queryKey: ["canvas-conflict", session, projectId], queryFn: () => getCanvasProject(projectId), enabled: open, staleTime: 0 });

    const resolve = async (action: "copy" | "reload") => {
        setBusy(true);
        try {
            const id = await useCanvasStore.getState().resolveConflict(projectId, action);
            assertCurrentSession(session);
            onClose();
            if (action === "copy") navigate(`/canvas/${id}`);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === session) message.error(error instanceof Error ? error.message : "处理失败，本地编辑已保留");
        } finally {
            if (useUserStore.getState().sessionVersion === session) setBusy(false);
        }
    };

    return <Modal open={open} title="处理画布版本冲突" onCancel={busy ? undefined : onClose} closable={!busy} mask={{ closable: !busy }} footer={[
        <Button key="close" disabled={busy} onClick={onClose}>继续查看本地</Button>,
        <Button key="reload" danger disabled={busy || !remote.data} onClick={() => modal.confirm({ title: "使用远端版本？", content: "当前未保存的本地编辑会被替换。需要保留时，请先选择“另存我的副本”。", okText: "使用远端版本", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => resolve("reload") })}>使用远端版本</Button>,
        <Button key="copy" type="primary" loading={busy} onClick={() => void resolve("copy")}>另存我的副本</Button>,
    ]}>
        <div className="space-y-4 py-3">
            <p>远端已更新，自动保存已暂停。另存副本会完整保留本地节点、连线与视口，并进入新的个人画布。</p>
            <div className="grid gap-3 sm:grid-cols-2">
                <div><p className="font-medium">本地编辑</p><p className="mt-1 break-words">{local?.title}</p><p className="text-sm opacity-60">版本 {local?.revision} · {local?.nodes.length || 0} 个节点 · {local?.connections.length || 0} 条连线</p></div>
                <div><p className="font-medium">远端内容</p>{remote.isPending ? <Spin size="small" /> : remote.data ? <><p className="mt-1 break-words">{remote.data.title}</p><p className="text-sm opacity-60">版本 {remote.data.revision} · {remote.data.nodeCount} 个节点 · {remote.data.connectionCount} 条连线</p></> : <Alert type="error" title={remote.error?.message || "远端暂时无法读取"} />}</div>
            </div>
        </div>
    </Modal>;
}
