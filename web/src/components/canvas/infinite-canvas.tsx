import React, { useCallback, useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onGestureStart?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onGestureStart, onCanvasDoubleClick, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const viewportRef = useRef(viewport);
    const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef<{ distance: number; worldX: number; worldY: number; scale: number } | null>(null);
    const multiTouchRef = useRef(false);
    const suppressClickRef = useRef(false);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(() => {
        viewportRef.current = viewport;
    }, [viewport]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            setIsControlPressed(false);
            const pointers = new Set([...touchPointsRef.current.keys(), panState.current.pointerId]);
            panState.current.isPanning = false;
            touchPointsRef.current.clear();
            pinchRef.current = null;
            multiTouchRef.current = false;
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
            nextViewportRef.current = null;
            setIsPanning(false);
            document.body.style.cursor = "";
            const container = containerRef.current;
            pointers.forEach((pointerId) => {
                if (container?.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
            });
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, [containerRef]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const current = nextViewportRef.current || viewportRef.current;
        const newScale = Math.min(Math.max(current.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - current.x) / current.k;
        const worldY = (mouseY - current.y) / current.k;

        onViewportChange({
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        });
    };

    const startPinch = useCallback(() => {
        const [first, second] = Array.from(touchPointsRef.current.values());
        const rect = containerRef.current?.getBoundingClientRect();
        if (!first || !second || !rect) return;
        const current = nextViewportRef.current || viewportRef.current;
        pinchRef.current = {
            distance: Math.hypot(second.x - first.x, second.y - first.y),
            worldX: ((first.x + second.x) / 2 - rect.left - current.x) / current.k,
            worldY: ((first.y + second.y) / 2 - rect.top - current.y) / current.k,
            scale: current.k,
        };
    }, [containerRef]);

    const handlePointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== "touch") {
            suppressClickRef.current = false;
            return;
        }
        if (!touchPointsRef.current.size) suppressClickRef.current = false;
        const target = event.target instanceof Element ? event.target : null;
        if (!touchPointsRef.current.size) {
            if (!target?.closest("[data-canvas-node-drag-handle]") && target?.closest("[data-canvas-no-zoom],[data-node-panel],[data-connection-create-menu],button,input,textarea,select,a,video,audio,[role='button'],[role='slider'],[role='combobox'],.ant-select,[contenteditable='true']")) return;
            // A touch begun outside the canvas must not turn its second finger into a node drag.
            if (!event.isPrimary) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
        }
        touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touchPointsRef.current.size < 2) return;
        event.preventDefault();
        event.stopPropagation();
        if (!multiTouchRef.current) {
            multiTouchRef.current = true;
            suppressClickRef.current = true;
            panState.current.isPanning = false;
            onGestureStart?.();
        }
        if (!pinchRef.current) startPinch();
        setIsPanning(true);
        // Taking both captures also cancels a resize handle's single-pointer gesture.
        touchPointsRef.current.forEach((_, pointerId) => event.currentTarget.setPointerCapture(pointerId));
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest("[data-canvas-node-drag-handle]") && target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan" && isBackgroundClick);

        if (shouldPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                initialX: (nextViewportRef.current || viewportRef.current).x,
                initialY: (nextViewportRef.current || viewportRef.current).y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (suppressClickRef.current) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (touchPointsRef.current.has(event.pointerId)) {
                touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            }
            const pinch = pinchRef.current;
            if (pinch && touchPointsRef.current.has(event.pointerId)) {
                const [first, second] = Array.from(touchPointsRef.current.values());
                const rect = containerRef.current?.getBoundingClientRect();
                if (!first || !second || !rect || !pinch.distance) return;
                const k = Math.min(Math.max(pinch.scale * Math.hypot(second.x - first.x, second.y - first.y) / pinch.distance, 0.05), 5);
                nextViewportRef.current = {
                    x: (first.x + second.x) / 2 - rect.left - pinch.worldX * k,
                    y: (first.y + second.y) / 2 - rect.top - pinch.worldY * k,
                    k,
                };
            } else {
                if (!panState.current.isPanning || panState.current.pointerId !== event.pointerId) return;

                const dx = event.clientX - panState.current.startX;
                const dy = event.clientY - panState.current.startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                    panState.current.hasMoved = true;
                    if (event.pointerType === "touch") suppressClickRef.current = true;
                }

                nextViewportRef.current = {
                    x: panState.current.initialX + dx,
                    y: panState.current.initialY + dy,
                    k: viewportRef.current.k,
                };
            }
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                if (nextViewportRef.current) {
                    viewportRef.current = nextViewportRef.current;
                    onViewportChange(nextViewportRef.current);
                    nextViewportRef.current = null;
                }
            });
        };

        const handlePointerUp = (event: PointerEvent) => {
            // Captures transferred from a node to the canvas are not a finished touch.
            if (event.type === "lostpointercapture" && event.target !== containerRef.current) return;
            const wasTouch = touchPointsRef.current.delete(event.pointerId);
            const wasPan = panState.current.isPanning && panState.current.pointerId === event.pointerId;
            if ((wasTouch || wasPan) && frameRef.current) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
                if (event.type === "pointerup" && nextViewportRef.current) {
                    viewportRef.current = nextViewportRef.current;
                    onViewportChange(nextViewportRef.current);
                }
                nextViewportRef.current = null;
            }
            if (wasTouch && multiTouchRef.current) {
                pinchRef.current = null;
                if (touchPointsRef.current.size >= 2) startPinch();
                if (!touchPointsRef.current.size) multiTouchRef.current = false;
                setIsPanning(touchPointsRef.current.size >= 2);
                document.body.style.cursor = "";
                return;
            }
            if (!panState.current.isPanning || panState.current.pointerId !== event.pointerId) return;

            if (event.type === "pointerup" && !panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        window.addEventListener("lostpointercapture", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            window.removeEventListener("lostpointercapture", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [containerRef, onCanvasDeselect, onViewportChange, startPinch]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDownCapture={handlePointerDownCapture}
            onPointerDown={handlePointerDown}
            onClickCapture={(event) => {
                if (!suppressClickRef.current) return;
                event.preventDefault();
                event.stopPropagation();
            }}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <div className="absolute inset-0 touch-none" />
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
