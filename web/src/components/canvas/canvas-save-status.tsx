import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Eye, LoaderCircle, TriangleAlert } from "lucide-react";
import { Tooltip, theme as antdTheme } from "antd";
import { useTranslation } from "react-i18next";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasSaveConflictModal } from "./canvas-save-conflict-modal";
import { CanvasRecoveryPrompt } from "./canvas-recovery-prompt";

export function CanvasSaveStatus({ readOnly = false, hasLocalChanges = false }: { readOnly?: boolean; hasLocalChanges?: boolean }) {
    const { id = "" } = useParams();
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === id));
    const state = useCanvasStore((store) => store.saveStates[id]);
    const retrySave = useCanvasStore((store) => store.retrySave);
    const recoveryError = useCanvasStore((store) => store.recoveryErrors[id]);
    const [conflictScope, setConflictScope] = useState("");
    const scope = `${sessionVersion}:${id}`;
    useEffect(() => setConflictScope(""), [scope]);
    if (!project?.snapshotLoaded) return null;
    const saveState = state?.sessionVersion === sessionVersion ? state : undefined;
    const error = saveState?.error;
    let indicator;
    if (error?.conflict) indicator = <>
        <Tooltip title={error.message}><button type="button" onClick={() => setConflictScope(scope)} aria-label="处理画布冲突" className="flex h-6 min-w-0 max-w-full items-center gap-1 rounded text-[10px] hover:bg-black/5 @min-[1024px]/canvas:h-8 @min-[1024px]/canvas:shrink-0 @min-[1024px]/canvas:px-1 @min-[1024px]/canvas:text-xs dark:hover:bg-white/10" style={{ color: token.colorError }}><TriangleAlert className="size-3.5 shrink-0" /><span className="truncate">处理画布冲突</span></button></Tooltip>
        <CanvasSaveConflictModal projectId={id} open={conflictScope === scope} onClose={() => setConflictScope("")} />
    </>;
    else if (readOnly || project.accessRole === "viewer") indicator = <span className="flex h-5 min-w-0 items-center gap-1 text-[10px] @min-[1024px]/canvas:h-8 @min-[1024px]/canvas:shrink-0 @min-[1024px]/canvas:text-xs" style={{ color: theme.node.muted }}><Eye className="size-3.5 shrink-0" /><span className="truncate">{t("workspace.readOnlyBadge")}</span></span>;
    else if (saveState?.phase === "saving") indicator = <span role="status" className="flex h-5 items-center gap-1 text-[10px] @min-[1024px]/canvas:h-8 @min-[1024px]/canvas:shrink-0 @min-[1024px]/canvas:gap-1.5 @min-[1024px]/canvas:text-xs" style={{ color: theme.node.muted }}><LoaderCircle className="size-3.5 shrink-0 animate-spin" />保存中</span>;
    else if (error) indicator = <Tooltip title={t("canvas.save.retryTip", { message: error.message })}><button type="button" aria-label={error.permanent ? t("canvas.save.blocked") : t("canvas.save.retrying")} className="flex h-6 min-w-0 max-w-full items-center gap-1 text-[10px] transition hover:opacity-75 @min-[1024px]/canvas:h-8 @min-[1024px]/canvas:shrink-0 @min-[1024px]/canvas:gap-1.5 @min-[1024px]/canvas:text-xs" style={{ color: token.colorError }} onClick={() => void retrySave(id)}><TriangleAlert className="size-3.5 shrink-0" /><span className="max-w-[160px] truncate">{error.permanent ? t("canvas.save.blocked") : t("canvas.save.retrying")}</span></button></Tooltip>;
    else if (recoveryError) indicator = <Tooltip title={recoveryError}><span role="status" className="text-xs" style={{ color: token.colorWarning }}>浏览器恢复副本不可用</span></Tooltip>;
    else indicator = <span role="status" className="flex h-5 items-center text-[10px] @min-[1024px]/canvas:h-8 @min-[1024px]/canvas:shrink-0 @min-[1024px]/canvas:text-xs" style={{ color: theme.node.muted }}>{hasLocalChanges || saveState?.phase === "pending" ? "待保存" : "已保存"}</span>;
    return <>{indicator}<CanvasRecoveryPrompt key={scope} projectId={id} /></>;
}
