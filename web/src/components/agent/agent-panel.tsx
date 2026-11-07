import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Grid } from "antd";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { LocalAgentPanel } from "./local-agent-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_AGENT_PANEL_MOTION_MS, useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;

export function AgentPanel() {
    const { t } = useTranslation();
    const screens = Grid.useBreakpoint();
    const mobile = !screens.lg;
    const panelRef = useRef<HTMLElement>(null);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const width = useAgentStore((state) => state.width);
    const [resizing, setResizing] = useState(false);
    const panelMounted = useAgentStore((state) => state.panelMounted);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const panelClosing = useAgentStore((state) => state.panelClosing);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const closePanel = useAgentStore((state) => state.closePanel);

    useEffect(() => {
        if (!mobile || !panelOpen) return;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        panelRef.current?.focus();
        return () => previousFocus?.focus();
    }, [mobile, panelOpen]);
    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(760, Math.max(360, startWidth + startX - moveEvent.clientX));
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            localStorage.setItem("canvas-agent-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!panelMounted) return null;

    return (
        <motion.div
            className="fixed inset-y-0 right-0 z-[100] flex h-dvh shrink-0 min-[992px]:relative min-[992px]:inset-auto min-[992px]:z-[70] min-[992px]:h-full"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? mobile ? "100%" : width + 1 : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: panelOpen && !panelClosing ? undefined : "none" }}
            inert={!panelOpen}
            aria-hidden={!panelOpen}
        >
            <motion.aside
                ref={panelRef}
                className="relative flex h-full min-h-0 shrink-0 flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] outline-none min-[992px]:border-l min-[992px]:p-0"
                data-canvas-shortcuts-ignore
                role={mobile ? "dialog" : undefined}
                aria-modal={mobile ? true : undefined}
                aria-label="Agent"
                tabIndex={-1}
                onKeyDown={(event) => { if (mobile && event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closePanel(); } }}
                initial={{ x: 48 }}
                animate={{ x: panelClosing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width: mobile ? "100vw" : width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 hidden w-4 -translate-x-1/2 cursor-col-resize min-[992px]:block" onPointerDown={startResize} aria-label={t("agent.panel.resize")} />
                <LocalAgentPanel embedded />
            </motion.aside>
        </motion.div>
    );
}
