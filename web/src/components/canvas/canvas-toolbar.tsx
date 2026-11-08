import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Segmented, Switch } from "antd";
import { CircleDot, Ellipsis, Eraser, Grid2x2, Group, Hand, Image as ImageIcon, Info, LocateFixed, Moon, MousePointer2, Music2, Palette, Plus, Puzzle, Redo2, Settings2, Square, Sun, Trash2, Type, Undo2, Upload, Video, X } from "lucide-react";

import { canvasThemes, type CanvasBackgroundMode, type CanvasColorTheme, type CanvasTheme } from "@/lib/canvas-theme";
import { getNodePluginId, listNodeDefinitions, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { getNodeSpec } from "@/constant/canvas";
import { useThemeStore } from "@/stores/use-theme-store";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useTranslation } from "react-i18next";

export function CanvasToolbar({
    selectedCount,
    canvasTool,
    canUndo,
    canRedo,
    backgroundMode,
    showImageInfo,
    onAddImage,
    onAddText,
    onAddConfig,
    onAddGroup,
    onAddExtensionNode,
    onUndo,
    onRedo,
    onUpload,
    onDelete,
    onClear,
    onCanvasToolChange,
    onBackgroundModeChange,
    onShowImageInfoChange,
    onFocusSelected,
}: {
    selectedCount: number;
    canvasTool: "select" | "pan";
    canUndo: boolean;
    canRedo: boolean;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onAddImage: () => void;
    onAddText: () => void;
    onAddConfig: () => void;
    onAddGroup: () => void;
    onAddExtensionNode: (type: string) => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onCanvasToolChange: (tool: "select" | "pan") => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onFocusSelected: () => void;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState<string | null>(null);
    const [tipX, setTipX] = useState(0);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [panelX, setPanelX] = useState(0);
    const [hintVisible, setHintVisible] = useState(() => localStorage.getItem("canvas-operation-hint-dismissed") !== "1");
    // Keep extension plugin nodes synchronized with registry changes.
    useNodeRegistryVersion();
    const extensionDefs = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false && getNodePluginId(def.type) !== "builtin");
    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)" };
    const hoverStyle = { background: theme.toolbar.itemHover, color: theme.toolbar.activeText };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const tip = hovered ? toolLabel(hovered, t) : "";

    // Close the appearance panel when clicking outside the toolbar.
    useEffect(() => {
        if (!appearanceOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setAppearanceOpen(false);
            }
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [appearanceOpen]);

    return (
        <div ref={rootRef} className="pointer-events-none absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] z-50 flex justify-center @min-[1024px]/canvas:bottom-5 @min-[1024px]/canvas:left-[300px] @min-[1024px]/canvas:right-4" data-canvas-bottom-toolbar data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
            {hintVisible ? <div className="pointer-events-auto absolute bottom-[calc(100%+12px)] hidden max-w-full items-center gap-2 text-xs @min-[1024px]/canvas:flex" style={{ color: theme.node.muted }}>
                <span>{canvasTool === "select" ? "拖动空白处框选 · 空格临时移动 · 滚轮缩放" : "拖动空白处移动 · 空格临时框选 · 滚轮缩放"}</span>
                <button type="button" className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label="不再显示操作提示" onClick={() => { localStorage.setItem("canvas-operation-hint-dismissed", "1"); setHintVisible(false); }}><X className="size-3.5" /></button>
            </div> : null}
            {tip ? <DockTip label={tip} x={tipX} theme={theme} /> : null}
            <div ref={wrapRef} className="thin-scrollbar pointer-events-auto flex h-14 max-w-full items-center gap-1 overflow-x-auto rounded-xl border px-2 shadow-lg backdrop-blur [&>*]:shrink-0" style={dockStyle}>
                <div className="flex items-center gap-0.5" role="group" aria-label="画布操作模式">
                    {(["select", "pan"] as const).map((tool) => <button key={tool} type="button" aria-pressed={canvasTool === tool} onClick={() => onCanvasToolChange(tool)} className="inline-flex h-11 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-black/5 @min-[1024px]/canvas:h-8 dark:hover:bg-white/10" style={canvasTool === tool ? activeStyle : { color: theme.toolbar.item }}>
                        {tool === "select" ? <MousePointer2 className="size-4" /> : <Hand className="size-4" />}{tool === "select" ? "选择" : "移动"}
                    </button>)}
                </div>
                <Dropdown trigger={["click"]} placement="topLeft" styles={{ root: { maxHeight: "calc(100dvh - 144px)", overflowY: "auto" } }} onOpenChange={(open) => { if (open) { setAppearanceOpen(false); setHovered(null); } }} menu={{ className: "[&_.ant-dropdown-menu-item]:min-h-11 [@media(pointer:fine)]:[&_.ant-dropdown-menu-item]:min-h-0", items: [
                    { key: "image", icon: <ImageIcon className="size-4" />, label: t("canvas.toolbar.image"), onClick: onAddImage },
                    { key: "text", icon: <Type className="size-4" />, label: t("canvas.toolbar.text"), onClick: onAddText },
                    { key: "video", icon: <Video className="size-4" />, label: t("canvas.toolbar.video"), onClick: () => onAddExtensionNode("video") },
                    { key: "audio", icon: <Music2 className="size-4" />, label: t("canvas.toolbar.audio"), onClick: () => onAddExtensionNode("audio") },
                    { key: "upload", icon: <Upload className="size-4" />, label: t("canvas.toolbar.upload"), onClick: onUpload },
                    { type: "divider" },
                    { key: "config", icon: <Settings2 className="size-4" />, label: t("canvas.toolbar.config"), onClick: onAddConfig },
                    { key: "group", icon: <Group className="size-4" />, label: t("canvas.toolbar.group"), onClick: onAddGroup },
                    ...extensionDefs.map((def) => ({ key: `plugin-${def.type}`, icon: def.icon, label: getNodeSpec(def.type).title, onClick: () => onAddExtensionNode(def.type) })),
                ] }}>
                    <button type="button" className="inline-flex h-11 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-sm hover:bg-black/5 @min-[1024px]/canvas:hidden dark:hover:bg-white/10" style={{ color: theme.toolbar.item }}><Plus className="size-4" />添加内容</button>
                </Dropdown>
                <Dropdown trigger={["click"]} placement="topRight" styles={{ root: { maxHeight: "calc(100dvh - 144px)", overflowY: "auto" } }} menu={{ className: "[&_.ant-dropdown-menu-item]:min-h-11", items: [
                    { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: t("canvas.undo"), onClick: onUndo },
                    { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: t("canvas.redo"), onClick: onRedo },
                    { key: "focus", disabled: !selectedCount, icon: <LocateFixed className="size-4" />, label: t("canvas.toolbar.focus"), onClick: onFocusSelected },
                    { key: "appearance", icon: <Palette className="size-4" />, label: t("canvas.toolbar.appearance"), onClick: () => { setPanelX(0); setAppearanceOpen(true); } },
                    { type: "divider" },
                    { key: "delete", disabled: !selectedCount, danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.deleteSelected"), onClick: onDelete },
                    { key: "clear", danger: true, icon: <Eraser className="size-4" />, label: t("canvas.toolbar.clear"), onClick: onClear },
                ] }}>
                    <button type="button" className="grid size-11 place-items-center rounded-md hover:bg-black/5 @min-[1024px]/canvas:hidden dark:hover:bg-white/10" aria-label="更多画布操作"><Ellipsis className="size-5" /></button>
                </Dropdown>
                <div className="hidden @min-[1024px]/canvas:contents">
                <Divider theme={theme} />
                <ToolbarButton id="tool-undo" label={t("canvas.undo")} disabled={!canUndo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onUndo}>
                    <Undo2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-redo" label={t("canvas.redo")} disabled={!canRedo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onRedo}>
                    <Redo2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-focus" label={t("canvas.toolbar.focus")} disabled={!selectedCount} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onFocusSelected}>
                    <LocateFixed className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                {[
                    { id: "text", icon: <Type className="size-4.5" />, action: onAddText },
                    { id: "image", icon: <ImageIcon className="size-4.5" />, action: onAddImage },
                    { id: "video", icon: <Video className="size-4.5" />, action: () => onAddExtensionNode("video") },
                    { id: "audio", icon: <Music2 className="size-4.5" />, action: () => onAddExtensionNode("audio") },
                    { id: "config", icon: <Settings2 className="size-4.5" />, action: onAddConfig },
                    { id: "group", icon: <Group className="size-4.5" />, action: onAddGroup },
                    { id: "upload", icon: <Upload className="size-4.5" />, action: onUpload },
                ].map(({ id, icon, action }) => (
                    <ToolbarButton key={id} id={`tool-${id}`} label={t(`canvas.toolbar.${id}`)} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={action}>{icon}</ToolbarButton>
                ))}
                {extensionDefs.length ? (
                    <Dropdown trigger={["click"]} placement="top" menu={{ items: extensionDefs.map((def) => ({ key: def.type, icon: def.icon, label: getNodeSpec(def.type).title, onClick: () => onAddExtensionNode(def.type) })) }} onOpenChange={(open) => { if (open) { setAppearanceOpen(false); setHovered(null); } }}>
                        <button type="button" className="grid size-8 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10" aria-label={t("canvas.toolbar.extensions")} title={t("canvas.toolbar.extensions")}><Puzzle className="size-4.5" /></button>
                    </Dropdown>
                ) : null}
                <Divider theme={theme} />
                <ToolbarButton
                    id="tool-style"
                    label={t("canvas.toolbar.appearance")}
                    active={appearanceOpen}
                    hovered={hovered}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipX={setTipX}
                    onHover={setHovered}
                    onClick={(event) => {
                        setPanelX(getTipX(wrapRef.current, event.currentTarget));
                        setAppearanceOpen((value) => !value);
                    }}
                >
                    <Palette className="size-4.5" />
                </ToolbarButton>
                {selectedCount ? (
                    <>
                        <Divider theme={theme} />
                        <ToolbarButton id="tool-delete" label={t("canvas.deleteSelected")} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onDelete} danger>
                            <Trash2 className="size-4.5" />
                        </ToolbarButton>
                    </>
                ) : null}
                <Divider theme={theme} />
                <ToolbarButton id="tool-clear" label={t("canvas.toolbar.clear")} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onClear} danger>
                    <Eraser className="size-4.5" />
                </ToolbarButton>
                </div>
            </div>

            {appearanceOpen ? (
                <div
                    className="thin-scrollbar pointer-events-auto absolute bottom-[72px] z-30 max-h-[calc(100dvh-160px)] w-[248px] max-w-full -translate-x-1/2 overflow-y-auto overscroll-contain rounded-xl border p-2.5 shadow-xl backdrop-blur"
                    style={{ left: panelX ? `clamp(124px, ${panelX}px, calc(100% - 124px))` : "50%", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                >
                    <div className="px-1 pb-2 text-sm font-medium opacity-65">{t("canvas.toolbar.appearance")}</div>
                    <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">{t("canvas.toolbar.themeMode")}</div>
                    <div className="grid grid-cols-2 gap-1 rounded-lg p-1" style={{ background: theme.toolbar.itemHover }}>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="light" onThemeChange={setTheme}>
                            <Sun className="size-4" />
                            {t("canvas.toolbar.light")}
                        </CanvasThemeButton>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="dark" onThemeChange={setTheme}>
                            <Moon className="size-4" />
                            {t("canvas.toolbar.dark")}
                        </CanvasThemeButton>
                    </div>
                    <div className="mt-3 px-1 pb-1.5 text-[11px] font-medium opacity-50">{t("canvas.toolbar.gridStyle")}</div>
                    <Segmented
                        className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                        value={backgroundMode}
                        onChange={(value) => onBackgroundModeChange(value as CanvasBackgroundMode)}
                        options={[
                            {
                                value: "dots",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <CircleDot className="size-4" />{t("canvas.toolbar.dots")}
                                    </span>
                                ),
                            },
                            {
                                value: "lines",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Grid2x2 className="size-4" />{t("canvas.toolbar.lines")}
                                    </span>
                                ),
                            },
                            {
                                value: "blank",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Square className="size-4" />
                                        {t("canvas.toolbar.blank")}
                                    </span>
                                ),
                            },
                        ]}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                            <Info className="size-3.5" />
                            {t("canvas.toolbar.imageInfo")}
                        </span>
                        <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function ToolbarButton({
    id,
    label,
    active,
    hovered,
    activeStyle,
    hoverStyle,
    wrapRef,
    onTipX,
    onHover,
    onClick,
    disabled = false,
    danger = false,
    children,
}: {
    id: string;
    label: string;
    active?: boolean;
    hovered: string | null;
    activeStyle?: CSSProperties;
    hoverStyle: CSSProperties;
    wrapRef: RefObject<HTMLDivElement | null>;
    onTipX: (x: number) => void;
    onHover: (id: string | null) => void;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <Button
            type="text"
            aria-label={label}
            title={label}
            className="!h-8 !w-8 !min-w-8 !p-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            disabled={disabled}
            style={active ? activeStyle : hovered === id && !disabled ? hoverStyle : { color: danger ? "#f87171" : theme.toolbar.item, opacity: disabled ? 0.35 : 1 }}
            icon={children}
            onMouseEnter={(event) => {
                onHover(id);
                onTipX(getTipX(wrapRef.current, event.currentTarget));
            }}
            onMouseLeave={() => onHover(null)}
            onClick={onClick}
        />
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="mx-1 h-6 w-px" style={{ background: theme.toolbar.border }} />;
}

function CanvasThemeButton({ colorTheme, targetTheme, onThemeChange, children }: { colorTheme: CanvasColorTheme; targetTheme: CanvasColorTheme; onThemeChange: (theme: CanvasColorTheme) => void; children: ReactNode }) {
    const theme = canvasThemes[colorTheme];
    const active = colorTheme === targetTheme;
    const activeStyle = colorTheme === "light" ? { background: "#111111", color: "#ffffff" } : { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const { t } = useTranslation();
    const label = targetTheme === "dark" ? t("topNav.darkTheme") : t("topNav.lightTheme");

    return (
        <AnimatedThemeToggler
            theme={colorTheme}
            targetTheme={targetTheme}
            onThemeChange={onThemeChange}
            className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition"
            style={active ? activeStyle : { color: theme.toolbar.item }}
            aria-label={label}
            title={label}
        >
            {children}
        </AnimatedThemeToggler>
    );
}

function DockTip({ label, x, theme }: { label: string; x: number; theme: CanvasTheme }) {
    return (
        <span className="absolute bottom-[calc(100%+8px)] -translate-x-1/2 rounded-md px-2 py-1 text-xs shadow-lg" style={{ left: x, background: theme.node.text, color: theme.node.panel }}>
            {label}
        </span>
    );
}

function toolLabel(id: string, t: (key: string) => string) {
    if (id === "tool-select") return t("canvas.toolbar.select");
    if (id === "tool-pan") return t("canvas.toolbar.pan");
    if (id === "tool-undo") return t("canvas.undo");
    if (id === "tool-redo") return t("canvas.redo");
    if (id === "tool-focus") return t("canvas.toolbar.focus");
    if (id === "tool-text") return t("canvas.toolbar.text");
    if (id === "tool-image") return t("canvas.toolbar.image");
    if (id === "tool-video") return t("canvas.toolbar.video");
    if (id === "tool-audio") return t("canvas.toolbar.audio");
    if (id === "tool-config") return t("canvas.toolbar.config");
    if (id === "tool-group") return t("canvas.toolbar.group");
    if (id === "tool-extensions") return t("canvas.toolbar.extensions");
    if (id === "tool-upload") return t("canvas.toolbar.upload");
    if (id === "tool-style") return t("canvas.toolbar.appearance");
    if (id === "tool-delete") return t("canvas.deleteSelected");
    if (id === "tool-clear") return t("canvas.toolbar.clear");
    return "";
}

function getTipX(wrap: HTMLDivElement | null, target: HTMLElement) {
    if (!wrap) return 0;
    const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.left - wrapBox.left + box.width / 2;
}
