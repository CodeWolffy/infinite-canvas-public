import { useEffect, useRef, useState } from "react";
import { BookOpen, Bot, Download, History, Home, Images, Menu, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Share2, Trash2, Undo2, Upload, Users } from "lucide-react";
import { Button, Dropdown, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { DOCS_URL } from "@/constant/env";
import { CanvasSaveStatus } from "@/components/canvas/canvas-save-status";
import { CanvasCollaborationStatus } from "@/components/canvas/canvas-collaboration-status";

export function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onExportProject,
    onImportImage,
    onOpenHistory,
    onUndo,
    onRedo,
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
    readOnly,
    hasLocalChanges = false,
    workspaceName,
    onShare,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onExportProject: () => void;
    onImportImage: () => void;
    onOpenHistory?: () => void;
    onUndo: () => void;
    onRedo: () => void;
    agentOpen: boolean;
    compactAgentStatus: { connected: boolean; enabled: boolean; activity: string };
    onToggleAgent: () => void;
    /** 工作区 viewer 只读：禁用改名入口并展示提示徽标。 */
    readOnly?: boolean;
    hasLocalChanges?: boolean;
    workspaceName?: string | null;
    onShare?: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const { t } = useTranslation();
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const sidePanelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const toggleSidePanel = useCanvasSidePanelStore((state) => state.togglePanel);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div data-canvas-top-bar data-canvas-no-zoom className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center justify-between gap-1 pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] @min-[1024px]/canvas:h-16 @min-[1024px]/canvas:gap-2 @min-[1024px]/canvas:pt-0 @min-[1024px]/canvas:pr-4">
                <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-0.5 @min-[1024px]/canvas:gap-2">
                    <Tooltip title={sidePanelOpen ? t("canvas.collapsePanel") : t("canvas.expandPanel")}>
                        <button
                            type="button"
                            onClick={toggleSidePanel}
                            aria-label={sidePanelOpen ? t("canvas.collapsePanel") : t("canvas.expandPanel")}
                            className="grid size-10 shrink-0 place-items-center rounded-md transition hover:bg-black/5 @min-[1024px]/canvas:size-8 dark:hover:bg-white/10"
                            style={{ color: theme.node.text }}
                        >
                            {sidePanelOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                        </button>
                    </Tooltip>
                    <Dropdown
                        trigger={["click"]}
                        styles={{ root: { maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100dvh - 72px)", overflowY: "auto" } }}
                        menu={{
                            className: "[&_.ant-dropdown-menu-item]:min-h-11 [@media(pointer:fine)]:[&_.ant-dropdown-menu-item]:min-h-0",
                            items: [
                                { key: "home", icon: <Home className="size-4" />, label: t("canvas.home"), onClick: onHome },
                                { key: "docs", icon: <BookOpen className="size-4" />, label: t("canvas.docs"), onClick: () => window.open(DOCS_URL, "_blank", "noopener,noreferrer") },
                                { key: "projects", icon: <Images className="size-4" />, label: t("canvas.projects"), onClick: onProjects },
                                { key: "rename", disabled: readOnly, icon: <Pencil className="size-4" />, label: "重命名画布", onClick: onStartTitleEditing },
                                ...(onShare ? [{ key: "share", icon: <Share2 className="size-4" />, label: "分享与协作", onClick: onShare }] : []),
                                { key: "agent", icon: <Bot className="size-4" />, label: agentOpen ? "关闭 Agent" : "打开 Agent", onClick: onToggleAgent },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: t("canvas.create"), onClick: onCreateProject },
                                { key: "delete", disabled: readOnly, danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.deleteCurrent"), onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", disabled: readOnly, icon: <Upload className="size-4" />, label: t("canvas.importAsset"), onClick: onImportImage },
                                { key: "export", icon: <Download className="size-4" />, label: t("canvas.exportCurrent"), onClick: onExportProject },
                                { key: "history", disabled: !onOpenHistory, icon: <History className="size-4" />, label: t("canvas.versionHistory", "版本历史"), onClick: onOpenHistory },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text={t("canvas.undo")} shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text={t("canvas.redo")} shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-10 shrink-0 place-items-center rounded-md transition hover:bg-black/5 @min-[1024px]/canvas:size-8 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("canvas.openMenu")}>
                            <Menu className="size-4" />
                        </button>
                    </Dropdown>

                    <div className="flex min-w-0 flex-1 flex-col @min-[1024px]/canvas:flex-row @min-[1024px]/canvas:items-center @min-[1024px]/canvas:gap-2">
                        <div ref={titleRef} className="flex min-w-0 items-center gap-2">
                            {isTitleEditing ? (
                                <input
                                    autoFocus
                                    value={titleDraft}
                                    onChange={(event) => onTitleDraftChange(event.target.value)}
                                    onBlur={onFinishTitleEditing}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") onFinishTitleEditing();
                                        if (event.key === "Escape") onCancelTitleEditing();
                                    }}
                                    className="w-full min-w-0 max-w-[280px] bg-transparent p-0 text-left text-base font-semibold tracking-normal outline-none @min-[1024px]/canvas:text-lg"
                                    aria-label="画布名称"
                                    style={{ color: theme.node.text }}
                                />
                            ) : (
                                <button
                                    type="button"
                                    className="max-w-[280px] truncate border-b border-dashed border-transparent text-left text-sm font-semibold tracking-normal transition hover:border-current @min-[1024px]/canvas:text-lg"
                                    onDoubleClick={readOnly ? undefined : onStartTitleEditing}
                                    title={readOnly ? undefined : t("canvas.renameHint")}
                                >
                                    {title}
                                </button>
                            )}
                            {workspaceName ? (
                                <span className="hidden max-w-[140px] items-center gap-1 truncate text-xs @min-[1024px]/canvas:flex" style={{ color: theme.node.muted }} title={workspaceName}>
                                    <Users className="size-3.5 shrink-0" />
                                    <span className="truncate">{workspaceName}</span>
                                </span>
                            ) : null}
                        </div>
                        <CanvasSaveStatus readOnly={readOnly} hasLocalChanges={hasLocalChanges} />
                    </div>
                    <div className="hidden @min-[1440px]/canvas:block"><CompactAgentStatus status={compactAgentStatus} onClick={onToggleAgent} /></div>
                </div>

                <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-0.5 @min-[1024px]/canvas:gap-1.5">
                    <div className="hidden @min-[1440px]/canvas:block"><CanvasCollaborationStatus /></div>
                    {onShare ? (
                        <Tooltip title="分享与协作">
                            <Button type="text" aria-label="分享与协作" className="!hidden !h-9 !rounded-lg !px-2.5 !font-medium @min-[1024px]/canvas:!inline-flex" style={{ color: theme.node.text }} icon={<Share2 className="size-4" />} onClick={onShare} />
                        </Tooltip>
                    ) : null}
                    <UserStatusActions variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} />
                    <span className="hidden h-6 w-px @min-[1024px]/canvas:block" style={{ background: theme.toolbar.border }} />
                    <Button type="text" className="!hidden !h-9 !rounded-lg !px-2.5 !font-medium @min-[1024px]/canvas:!inline-flex" style={{ background: agentOpen ? theme.toolbar.activeBg : "transparent", color: theme.node.text }} icon={<Bot className="size-4" />} onClick={onToggleAgent}>Agent</Button>
                </div>
            </div>
            <Modal title={t("canvas.shortcuts")} open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["Ctrl / Space", t("canvas.shortcut.drag")]} value={t("canvas.shortcut.toggleTool")} />
                    <Shortcut keys={[t("canvas.shortcut.wheel")]} value={t("canvas.shortcut.zoom")} />
                    <Shortcut keys={[t("canvas.shortcut.zoomSlider")]} value={t("canvas.shortcut.preciseZoom")} />
                    <Shortcut keys={[t("canvas.shortcut.drag")]} value={t("canvas.shortcut.boxSelect")} />
                    <Shortcut keys={["Shift / Cmd", t("canvas.shortcut.click")]} value={t("canvas.shortcut.addSelection")} />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value={t("canvas.shortcut.selectAll")} />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value={t("canvas.shortcut.copyPaste")} />
                    <Shortcut keys={["Ctrl / Cmd", "G"]} value={t("canvas.shortcut.group")} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "G"]} value={t("canvas.shortcut.ungroup")} />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value={t("canvas.undo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Delete / Backspace"]} value={t("canvas.shortcut.delete")} />
                    <Shortcut keys={["Esc"]} value={t("canvas.shortcut.escape")} />
                    <Shortcut keys={[t("canvas.shortcut.dropMedia")]} value={t("canvas.shortcut.upload")} />
                </div>
            </Modal>
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function CompactAgentStatus({ status, onClick }: { status: { connected: boolean; enabled: boolean; activity: string }; onClick: () => void }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const { t } = useTranslation();
    const label = status.connected ? t("canvas.agentConnected") : status.enabled ? t("canvas.agentConnecting", { activity: status.activity || t("canvas.connecting") }) : t("canvas.agentDisconnected");
    const dotColor = status.connected ? "#22c55e" : status.enabled ? "#f59e0b" : theme.node.muted;
    return <button type="button" className="flex h-8 items-center gap-1.5 text-xs transition hover:opacity-75" style={{ color: status.connected ? "#16a34a" : status.enabled ? "#d97706" : theme.node.muted }} onClick={onClick} title={t("canvas.openAgent")}><span className="size-2 rounded-full" style={{ background: dotColor }} /><span className="max-w-[140px] truncate">{label}</span></button>;
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-6 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2.5 py-1.5 text-center text-xs font-medium leading-none shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: "rgba(120,113,108,.28)", background: "linear-gradient(#fff, rgba(245,245,244,.92))", color: "rgb(68,64,60)" }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{value}</span>
        </div>
    );
}
