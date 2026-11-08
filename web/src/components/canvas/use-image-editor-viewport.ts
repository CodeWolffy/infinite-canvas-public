import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

type ImageSize = { width: number; height: number };

const minZoom = 1;
const maxZoom = 4;
const zoomStep = 1.2;
const viewportPadding = 16;

export function useImageEditorViewport(image: ImageSize | null, open: boolean, mode: "edit" | "preview" = "edit") {
    const viewportNodeRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const panRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);
    const zoomAnchorRef = useRef<{ zoom: number; ratioX: number; ratioY: number; viewportX: number; viewportY: number } | null>(null);
    const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
    const [viewportSize, setViewportSize] = useState<ImageSize>({ width: 0, height: 0 });
    const [zoom, setZoom] = useState(minZoom);
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [spacePressed, setSpacePressed] = useState(false);
    const spacePressedRef = useRef(false);
    const viewportRef = useCallback((node: HTMLDivElement | null) => {
        viewportNodeRef.current = node;
        setViewportElement(node);
    }, []);

    useEffect(() => {
        if (!open) return;
        const pan = panRef.current;
        panRef.current = null;
        if (pan && viewportNodeRef.current?.hasPointerCapture(pan.pointerId)) viewportNodeRef.current.releasePointerCapture(pan.pointerId);
        setIsPanning(false);
        zoomAnchorRef.current = null;
        setZoom(minZoom);
        setPanOffset({ x: 0, y: 0 });
    }, [open, image?.width, image?.height]);

    useEffect(() => {
        if (!open || mode === "preview") return;
        const releaseSpace = () => {
            spacePressedRef.current = false;
            setSpacePressed(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space" || event.repeat) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (document.activeElement instanceof HTMLElement && document.activeElement.matches("button,a,[role='button']")) document.activeElement.blur();
            spacePressedRef.current = true;
            setSpacePressed(true);
        };
        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code !== "Space" || !spacePressedRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            releaseSpace();
        };
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("blur", releaseSpace);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("keyup", handleKeyUp, true);
            window.removeEventListener("blur", releaseSpace);
            spacePressedRef.current = false;
        };
    }, [mode, open]);

    useEffect(() => {
        if (!open || !viewportElement) return;
        const updateSize = () => {
            const width = viewportElement.clientWidth;
            const height = viewportElement.clientHeight;
            setViewportSize((current) => (current.width === width && current.height === height ? current : { width, height }));
        };
        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(viewportElement);
        return () => observer.disconnect();
    }, [open, viewportElement]);

    const baseSize = fitImage(image, viewportSize);
    const originalZoom = image && baseSize.width ? image.width / baseSize.width : minZoom;
    const zoomLimit = mode === "preview" ? Math.max(maxZoom, originalZoom) : maxZoom;
    const stageSize = { width: baseSize.width * zoom, height: baseSize.height * zoom };
    const contentSize = {
        width: mode === "preview" ? viewportSize.width : Math.max(viewportSize.width, stageSize.width),
        height: mode === "preview" ? viewportSize.height : Math.max(viewportSize.height, stageSize.height),
    };
    const stageOffset = {
        left: mode === "preview" ? (contentSize.width - stageSize.width) / 2 + panOffset.x : Math.max(0, Math.round((contentSize.width - stageSize.width) / 2)),
        top: mode === "preview" ? (contentSize.height - stageSize.height) / 2 + panOffset.y : Math.max(0, Math.round((contentSize.height - stageSize.height) / 2)),
    };

    useLayoutEffect(() => {
        const viewport = viewportNodeRef.current;
        const anchor = zoomAnchorRef.current;
        if (!viewport || !anchor || Math.abs(anchor.zoom - zoom) > 0.001) return;
        const nextWidth = baseSize.width * zoom;
        const nextHeight = baseSize.height * zoom;
        if (mode === "preview") {
            setPanOffset({ x: anchor.viewportX - anchor.ratioX * nextWidth - (viewport.clientWidth - nextWidth) / 2, y: anchor.viewportY - anchor.ratioY * nextHeight - (viewport.clientHeight - nextHeight) / 2 });
            zoomAnchorRef.current = null;
            return;
        }
        const nextLeft = Math.max(0, (Math.max(viewport.clientWidth, nextWidth) - nextWidth) / 2);
        const nextTop = Math.max(0, (Math.max(viewport.clientHeight, nextHeight) - nextHeight) / 2);
        viewport.scrollLeft = nextLeft + anchor.ratioX * nextWidth - anchor.viewportX;
        viewport.scrollTop = nextTop + anchor.ratioY * nextHeight - anchor.viewportY;
        zoomAnchorRef.current = null;
    }, [baseSize.height, baseSize.width, mode, zoom]);

    const setZoomAround = useCallback(
        (nextZoom: number, clientX?: number, clientY?: number) => {
            const viewport = viewportNodeRef.current;
            const stage = stageRef.current;
            if (!viewport || !stage || !baseSize.width || !baseSize.height) return;

            const boundedZoom = clamp(nextZoom, minZoom, zoomLimit);
            if (Math.abs(boundedZoom - zoom) < 0.001) return;

            const viewportRect = viewport.getBoundingClientRect();
            const stageRect = stage.getBoundingClientRect();
            const pointerX = clientX ?? viewportRect.left + viewportRect.width / 2;
            const pointerY = clientY ?? viewportRect.top + viewportRect.height / 2;
            const pointX = (pointerX - stageRect.left) / Math.max(1, stageRect.width);
            const pointY = (pointerY - stageRect.top) / Math.max(1, stageRect.height);
            const ratioX = mode === "preview" ? pointX : clamp(pointX, 0, 1);
            const ratioY = mode === "preview" ? pointY : clamp(pointY, 0, 1);
            const viewportX = pointerX - viewportRect.left;
            const viewportY = pointerY - viewportRect.top;

            zoomAnchorRef.current = { zoom: boundedZoom, ratioX, ratioY, viewportX, viewportY };
            setZoom(boundedZoom);
        },
        [baseSize.height, baseSize.width, mode, zoom, zoomLimit],
    );

    useEffect(() => {
        if (!open || !viewportElement) return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (!event.deltaY) return;
            setZoomAround(event.deltaY < 0 ? zoom * zoomStep : zoom / zoomStep, event.clientX, event.clientY);
        };
        viewportElement.addEventListener("wheel", handleWheel, { passive: false });
        return () => viewportElement.removeEventListener("wheel", handleWheel);
    }, [open, setZoomAround, viewportElement, zoom]);

    const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (panRef.current) return;
        if (mode === "preview" && event.target instanceof Element && event.target.closest("button")) return;
        if (event.button !== 1 && !(event.button === 0 && (mode === "preview" || spacePressedRef.current))) return;
        event.preventDefault();
        event.stopPropagation();
        const viewport = event.currentTarget;
        panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: mode === "preview" ? panOffset.x : -viewport.scrollLeft, offsetY: mode === "preview" ? panOffset.y : -viewport.scrollTop };
        viewport.setPointerCapture(event.pointerId);
        setIsPanning(true);
    }, [mode, panOffset.x, panOffset.y]);
    const movePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = panRef.current;
        if (!pan || event.pointerId !== pan.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const x = pan.offsetX + event.clientX - pan.x;
        const y = pan.offsetY + event.clientY - pan.y;
        if (mode === "preview") setPanOffset({ x, y });
        else {
            event.currentTarget.scrollLeft = -x;
            event.currentTarget.scrollTop = -y;
        }
    }, [mode]);
    const stopPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = panRef.current;
        if (!pan || event.pointerId !== pan.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        panRef.current = null;
        setIsPanning(false);
    }, []);
    const preventAuxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    return {
        viewportRef,
        stageRef,
        zoom,
        isPanning,
        spacePressed,
        scrollClassName: mode === "edit" && zoom > minZoom + 0.001 ? "overflow-scroll" : "overflow-hidden",
        panHandlers: {
            onPointerDownCapture: startPan,
            onPointerMoveCapture: movePan,
            onPointerUpCapture: stopPan,
            onPointerCancelCapture: stopPan,
            onLostPointerCapture: () => { panRef.current = null; setIsPanning(false); },
            onAuxClick: preventAuxClick,
        },
        canZoomIn: zoom < zoomLimit,
        canZoomOut: zoom > minZoom,
        imageScale: image ? stageSize.width / image.width : 0,
        zoomIn: () => setZoomAround(zoom * zoomStep),
        zoomOut: () => setZoomAround(zoom / zoomStep),
        resetZoom: () => {
            setZoomAround(minZoom);
            if (mode === "preview") {
                zoomAnchorRef.current = null;
                setPanOffset({ x: 0, y: 0 });
            }
        },
        showOriginal: (clientX?: number, clientY?: number) => setZoomAround(originalZoom, clientX, clientY),
        contentStyle: { width: contentSize.width, height: contentSize.height } satisfies CSSProperties,
        stageStyle: {
            left: stageOffset.left,
            top: stageOffset.top,
            width: stageSize.width,
            height: stageSize.height,
        } satisfies CSSProperties,
        mediaStyle: {
            width: baseSize.width,
            height: baseSize.height,
            transform: `translateZ(0) scale(${zoom})`,
            transformOrigin: "top left",
        } satisfies CSSProperties,
    };
}

function fitImage(image: ImageSize | null, viewport: ImageSize): ImageSize {
    if (!image || !viewport.width || !viewport.height) return { width: 0, height: 0 };
    const availableWidth = Math.max(1, viewport.width - viewportPadding * 2);
    const availableHeight = Math.max(1, viewport.height - viewportPadding * 2);
    const scale = Math.min(availableWidth / image.width, availableHeight / image.height, 1);
    return { width: image.width * scale, height: image.height * scale };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
