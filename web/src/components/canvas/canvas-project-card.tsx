import { AudioLines, Check, Download, FileText, Image, LayoutDashboard, Pencil, Share2, SlidersHorizontal, Trash2, Users, Video, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { ShareDialog } from "@/components/share-dialog";
import { WorkspaceMoveButton } from "@/components/workspace-move-button";

const previewKinds = {
    image: { icon: Image, label: "图片画布" },
    text: { icon: FileText, label: "文本画布" },
    video: { icon: Video, label: "视频画布" },
    audio: { icon: AudioLines, label: "音频画布" },
    config: { icon: SlidersHorizontal, label: "创作配置" },
};

export function CanvasProjectCard({ project, compact = false }: { project: CanvasProject; compact?: boolean }) {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [shareOpen, setShareOpen] = useState(false);
    const [failedCover, setFailedCover] = useState("");
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const themeName = useThemeStore((state) => state.theme);
    const theme = canvasThemes[themeName];
    const renameProject = useCanvasStore((state) => state.renameProject);
    const loadProjects = useCanvasStore((state) => state.loadProjects);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = !compact && editingId === project.id;
    const selected = !compact && selectedIds.includes(project.id);
    const preview = previewKinds[project.previewType as keyof typeof previewKinds] || { icon: LayoutDashboard, label: "画布预览" };
    const PreviewIcon = preview.icon;
    const open = () => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const saveTitle = () => {
        void renameProject(project.id, editingTitle);
        stopEditing();
    };
    const exportProject = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const loaded = await loadProjects([project.id]);
        assertCurrentSession(sessionVersion);
        await exportCanvasProjects(loaded, project.title || t("canvas.title"));
    };
    const writable = project.accessRole !== "viewer";
    const isOwner = project.accessRole === "owner";
    const updated = t("canvas.project.updated", { date: new Date(project.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) });

    return (
        <article className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border transition" style={{ background: theme.node.panel, borderColor: selected ? theme.node.activeStroke : theme.node.stroke, color: theme.node.text }} onClick={() => !editing && open()}>
            <div className="relative">
                <button type="button" aria-label={`打开画布：${project.title}`} onClick={(event) => { event.stopPropagation(); open(); }} className="flex aspect-[16/9] w-full cursor-pointer items-center justify-center overflow-hidden" style={{ background: theme.canvas.background }}>
                    {project.coverUrl && failedCover !== project.coverUrl ? <img key={project.coverUrl} src={project.coverUrl} alt={project.title} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]" onError={() => { if (useUserStore.getState().sessionVersion === sessionVersion) setFailedCover(project.coverUrl || ""); }} /> : <span className="flex flex-col items-center gap-3" style={{ color: theme.node.placeholder }}><PreviewIcon className="size-9" strokeWidth={1.25} /><span className="text-xs">{project.nodeCount ? preview.label : "空白画布"}</span></span>}
                </button>
                {!compact ? <label className="absolute left-3 top-3 flex size-7 cursor-pointer items-center justify-center rounded-md" style={{ background: theme.node.panel }} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected} onChange={(event) => toggleSelected(project.id, event.target.checked)} className="size-4 accent-current" aria-label={t("canvas.project.select", { name: project.title })} /></label> : null}
            </div>
            <div className={compact ? "flex flex-1 flex-col gap-2 p-4" : "flex flex-1 flex-col p-4"}>
                {editing ? <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus /> : <button type="button" className="min-w-0 cursor-pointer text-left" onClick={(event) => { event.stopPropagation(); open(); }}><h2 className="truncate text-base font-semibold">{project.title}</h2>{!compact ? <p className="mt-2 text-xs leading-5" style={{ color: theme.node.muted }}>{t("canvas.project.stats", { nodes: project.nodeCount, connections: project.connectionCount })}</p> : null}</button>}
                {project.workspaceName ? <p className="mt-1 inline-flex items-center gap-1 text-xs" style={{ color: theme.node.muted }}><Users className="size-3" />{project.workspaceName}{!writable ? ` · ${t("workspace.roles.viewer")}` : ""}</p> : null}
                <div className={compact ? "mt-auto pt-1" : "mt-auto flex flex-wrap items-end justify-between gap-2 pt-4"}>
                    <p className="text-xs" style={{ color: theme.node.placeholder }}>{updated}</p>
                    {!compact ? <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                        {editing ? <>
                            <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={saveTitle} aria-label={t("canvas.project.saveName")} />
                            <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label={t("canvas.project.cancelRename")} />
                        </> : <>
                            <Button type="text" size="small" shape="circle" icon={<Download className="size-4" />} onClick={() => void exportProject()} aria-label={t("canvas.project.export")} />
                            {isOwner ? <Button type="text" size="small" shape="circle" icon={<Share2 className="size-4" />} onClick={() => setShareOpen(true)} aria-label={t("share.title")} /> : null}
                            {isOwner ? <WorkspaceMoveButton target={{ kind: "canvas", id: project.id, workspaceId: project.workspaceId }} onMoved={(workspaceId, workspaceName) => {
                                useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === project.id ? { ...item, workspaceId, workspaceName } : item) }));
                                const state = useCanvasStore.getState();
                                const sessionVersion = useUserStore.getState().sessionVersion;
                                void state.refreshProjectList(state.projectQuery).catch((error: unknown) => { if (useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : "画布加载失败"); });
                            }} /> : null}
                            {writable ? <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label={t("canvas.project.rename")} /> : null}
                            {project.canDelete ? <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label={t("canvas.project.delete")} /> : null}
                        </>}
                    </div> : null}
                </div>
            </div>
            {shareOpen ? <ShareDialog kind="canvas" targetId={project.id} open={shareOpen} onClose={() => setShareOpen(false)} /> : null}
        </article>
    );
}
