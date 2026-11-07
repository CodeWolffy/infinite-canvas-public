import { Tooltip } from "antd";
import { Users } from "lucide-react";
import { useCanvasCollaborationStore } from "@/stores/canvas/use-canvas-collaboration-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";

export function CanvasCollaborationStatus() {
    const { members, status, remoteUpdatedAt } = useCanvasCollaborationStore();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (members.length < 2) return null;
    const label = status === "online" ? `${members.length} 人在线` : status === "connecting" ? "连接协作中" : status === "unavailable" ? "访问权限已变更" : "协作连接中断";
    return <Tooltip title={<div><div>{members.map((member) => member.displayName || member.username).join("、") || label}</div>{remoteUpdatedAt ? <div>已接收远端更新，若有冲突请通过保存状态处理</div> : null}{status === "reconnecting" ? <div>正在重新连接，本地未保存编辑会保留</div> : null}</div>}>
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs" style={{ color: theme.node.muted }} role="status"><Users className="size-3.5" />{label}{status === "online" && remoteUpdatedAt ? <span className="hidden lg:inline"> · 已接收更新</span> : null}</span>
    </Tooltip>;
}
