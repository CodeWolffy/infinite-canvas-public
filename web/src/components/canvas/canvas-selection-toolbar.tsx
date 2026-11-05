import type { ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, AlignStartVertical, AlignVerticalJustifyCenter, AlignEndVertical, ArrowLeftRight, ArrowUpDown, Grid2X2, Group, Ungroup } from "lucide-react";
import { Dropdown, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

import type { ArrangeAction } from "@/lib/canvas/canvas-arrange";

const SELECTION_PAD = 14;

export function CanvasSelectionToolbar({
    nodes,
    viewport,
    showToolbar,
    canGroup,
    canUngroup,
    onGroup,
    onUngroup,
    onArrange,
    arrangeDisabled,
}: {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    showToolbar: boolean;
    canGroup: boolean;
    canUngroup: boolean;
    onGroup: () => void;
    onUngroup: () => void;
    onArrange: (action: ArrangeAction) => void;
    arrangeDisabled: { distributeHorizontal: boolean; distributeVertical: boolean };
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (nodes.length < 2) return null;

    const bounds = nodeBounds(nodes);
    const left = viewport.x + bounds.left * viewport.k - SELECTION_PAD;
    const top = viewport.y + bounds.top * viewport.k - SELECTION_PAD;
    const width = (bounds.right - bounds.left) * viewport.k + SELECTION_PAD * 2;
    const height = (bounds.bottom - bounds.top) * viewport.k + SELECTION_PAD * 2;
    const showActions = showToolbar && (canGroup || canUngroup || nodes.length >= 2);

    return (
        <>
            <svg className="pointer-events-none absolute z-[65] overflow-visible" style={{ left, top, width, height }}>
                <rect
                    x={1}
                    y={1}
                    width={Math.max(width - 2, 0)}
                    height={Math.max(height - 2, 0)}
                    rx={16}
                    ry={16}
                    fill={theme.canvas.selectionFill}
                    stroke={theme.canvas.selectionStroke}
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    strokeDasharray="7 5"
                    strokeLinecap="round"
                />
            </svg>
            {showActions ? (
                <div
                    className="absolute z-[70] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border text-[15px] shadow-[0_8px_28px_rgba(15,23,42,.12)]"
                    style={{ left: left + width / 2, top: top - 8, borderColor: theme.toolbar.border, background: theme.toolbar.panel, color: theme.toolbar.item }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {canGroup ? <SelectionAction title={t("canvas.nodeToolbar.groupTitle")} label={t("canvas.nodeToolbar.group")} icon={<Group className="size-4" />} onClick={onGroup} /> : null}
                    {canUngroup ? <SelectionAction title={t("canvas.nodeToolbar.ungroupTitle")} label={t("canvas.nodeToolbar.ungroup")} icon={<Ungroup className="size-4" />} onClick={onUngroup} /> : null}
                    <Dropdown trigger={["click"]} placement="top" menu={{ items: arrangeItems(arrangeDisabled), onClick: ({ key }) => onArrange(key as ArrangeAction) }}>
                        <button type="button" className="group relative flex h-12 items-center whitespace-nowrap px-1.5" aria-label="整理选区" title="整理选区">
                            <span className="flex h-9 items-center gap-2 rounded-lg px-2.5 transition group-hover:bg-black/5 dark:group-hover:bg-white/10"><Grid2X2 className="size-4" /><span>整理</span></span>
                        </button>
                    </Dropdown>
                </div>
            ) : null}
        </>
    );
}


function arrangeItems(disabled: { distributeHorizontal: boolean; distributeVertical: boolean }) {
    return [
        { key: "left", label: "左对齐", icon: <AlignLeft className="size-4" /> },
        { key: "centerX", label: "水平居中", icon: <AlignCenter className="size-4" /> },
        { key: "right", label: "右对齐", icon: <AlignRight className="size-4" /> },
        { type: "divider" as const },
        { key: "top", label: "上对齐", icon: <AlignStartVertical className="size-4" /> },
        { key: "centerY", label: "垂直居中", icon: <AlignVerticalJustifyCenter className="size-4" /> },
        { key: "bottom", label: "下对齐", icon: <AlignEndVertical className="size-4" /> },
        { type: "divider" as const },
        { key: "distributeHorizontal", label: disabled.distributeHorizontal ? "横向等距（至少 3 项）" : "横向等距", icon: <ArrowLeftRight className="size-4" />, disabled: disabled.distributeHorizontal },
        { key: "distributeVertical", label: disabled.distributeVertical ? "纵向等距（至少 3 项）" : "纵向等距", icon: <ArrowUpDown className="size-4" />, disabled: disabled.distributeVertical },
        { type: "divider" as const },
        { key: "grid", label: "网格整理", icon: <Grid2X2 className="size-4" /> },
    ];
}

function SelectionAction({ title, label, icon, onClick }: { title: string; label: string; icon: ReactNode; onClick: () => void }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2}>
            <button type="button" className="group relative flex h-12 items-center whitespace-nowrap px-1.5" onClick={onClick} aria-label={title}>
                <span className="flex h-9 items-center gap-2 rounded-lg px-2.5 transition group-hover:bg-black/5 dark:group-hover:bg-white/10">
                    {icon}
                    <span>{label}</span>
                </span>
            </button>
        </Tooltip>
    );
}
