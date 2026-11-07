import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Modal } from "antd";
import { ChevronLeft, ChevronRight, Download, LoaderCircle, Maximize, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasNodeData } from "@/types/canvas";

const buttonClass = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition-colors hover:bg-black/5 focus-visible:outline-2 disabled:cursor-default disabled:opacity-30 dark:hover:bg-white/10";

export function CanvasImagePreview({ node, initialImageId, onClose, onDownload }: { node: CanvasNodeData; initialImageId: string | null; onClose: () => void; onDownload: (imageId?: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const sessionVersion = useRef(useUserStore.getState().sessionVersion).current;
    const batch = node.metadata?.images?.filter((image) => image.content) || [];
    const images = batch.length ? batch : [{ id: node.id, content: node.metadata?.content || "" }];
    const [selectedId, setSelectedId] = useState(() => initialImageId || node.metadata?.primaryImageId || images.find((image) => image.content === node.metadata?.content)?.id);
    const current = Math.max(0, images.findIndex((image) => image.id === selectedId));
    const image = images[current];
    const [attempt, setAttempt] = useState(0);
    const imageKey = `${image.id}:${image.content}:${attempt}`;
    const [loaded, setLoaded] = useState<{ key: string; size: { width: number; height: number } | null; failed: boolean } | null>(null);
    const size = loaded?.key === imageKey ? loaded.size : null;
    const failed = loaded?.key === imageKey && loaded.failed;
    const imageRef = useRef<HTMLImageElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const viewport = useImageEditorViewport(size, true, "preview");

    useLayoutEffect(() => {
        // Loading disables the toolbar; keep its focus inside the viewer when switching images.
        contentRef.current?.focus({ preventScroll: true });
    }, [imageKey]);

    const changeImage = (offset: number) => {
        const next = images[current + offset];
        if (next) {
            setLoaded(null);
            setSelectedId(next.id);
        }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Tab") return; // Keep the Modal's focus trap.
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.preventDefault();
            changeImage(event.key === "ArrowLeft" ? -1 : 1);
        }
    };

    return (
        <Modal
            open
            aria-label={t("canvas.projectPage.imageDetails")}
            footer={null}
            closable={false}
            onCancel={onClose}
            width="100vw"
            style={{ top: 0, margin: 0, paddingBottom: 0, maxWidth: "100vw" }}
            styles={{ wrapper: { overflow: "hidden" }, container: { padding: 0, borderRadius: 0, boxShadow: "none", background: theme.canvas.background, color: theme.node.text } }}
            transitionName=""
            maskTransitionName=""
            wrapProps={{ onKeyDown: handleKeyDown, onKeyUp: (event: KeyboardEvent) => event.stopPropagation() }}
        >
            <div ref={contentRef} tabIndex={-1} data-canvas-no-zoom data-canvas-shortcuts-ignore className="relative flex h-dvh flex-col outline-none">
                <button type="button" autoFocus className={`${buttonClass} absolute right-3 top-3 z-10`} aria-label={t("canvas.imagePreview.close")} title={t("canvas.imagePreview.close")} onClick={onClose}><X className="size-5" /></button>
                <div
                    ref={viewport.viewportRef}
                    {...viewport.panHandlers}
                    className={`relative min-h-0 flex-1 touch-none overscroll-contain select-none ${viewport.scrollClassName} ${size ? viewport.isPanning ? "cursor-grabbing" : "cursor-grab" : ""}`}
                    aria-busy={!size && !failed}
                    onDoubleClick={(event) => {
                        if (!size) return;
                        if (viewport.zoom === 1) viewport.showOriginal(event.clientX, event.clientY);
                        else viewport.resetZoom();
                    }}
                >
                    <div className="relative" style={viewport.contentStyle}>
                        <div ref={viewport.stageRef} className="absolute" style={viewport.stageStyle}>
                            <img
                                key={imageKey}
                                ref={imageRef}
                                src={image.content}
                                alt={node.title || t("assets.kinds.image")}
                                draggable={false}
                                className="block max-w-none"
                                style={{ ...viewport.mediaStyle, visibility: size ? "visible" : "hidden" }}
                                onLoad={(event) => {
                                    const target = event.currentTarget;
                                    if (target !== imageRef.current || useUserStore.getState().sessionVersion !== sessionVersion) return;
                                    setLoaded({ key: imageKey, size: { width: target.naturalWidth, height: target.naturalHeight }, failed: false });
                                }}
                                onError={(event) => {
                                    if (event.currentTarget !== imageRef.current || useUserStore.getState().sessionVersion !== sessionVersion) return;
                                    setLoaded({ key: imageKey, size: null, failed: true });
                                }}
                            />
                        </div>
                    </div>
                    {!size ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ color: theme.node.muted }}>
                            {failed ? (
                                <>
                                    <span role="alert">{t("canvas.imagePreview.failed")}</span>
                                    <button type="button" className={buttonClass} onClick={() => setAttempt((value) => value + 1)}><RotateCcw className="size-4" />{t("canvas.node.retry")}</button>
                                </>
                            ) : <span role="status" className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />{t("canvas.imagePreview.loading")}</span>}
                        </div>
                    ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-1" style={{ color: theme.toolbar.item }}>
                    {images.length > 1 ? (
                        <div className="flex items-center gap-1">
                            <button type="button" className={buttonClass} disabled={current === 0} aria-label={t("canvas.imagePreview.previous")} onClick={() => changeImage(-1)}><ChevronLeft className="size-4" /></button>
                            <span className="text-xs tabular-nums" aria-live="polite">{current + 1} / {images.length}</span>
                            <button type="button" className={buttonClass} disabled={current === images.length - 1} aria-label={t("canvas.imagePreview.next")} onClick={() => changeImage(1)}><ChevronRight className="size-4" /></button>
                        </div>
                    ) : null}
                    <div className="flex items-center">
                        <button type="button" className={buttonClass} disabled={!size || !viewport.canZoomOut} aria-label={t("canvas.editors.zoomOut")} title={t("canvas.editors.zoomOut")} onClick={viewport.zoomOut}><ZoomOut className="size-4" /></button>
                        <span className="min-w-14 text-center text-xs tabular-nums">{size ? `${Math.round(viewport.imageScale * 100)}%` : "—"}</span>
                        <button type="button" className={buttonClass} disabled={!size || !viewport.canZoomIn} aria-label={t("canvas.editors.zoomIn")} title={t("canvas.editors.zoomIn")} onClick={viewport.zoomIn}><ZoomIn className="size-4" /></button>
                    </div>
                    <button type="button" className={buttonClass} disabled={!size} onClick={viewport.resetZoom}><Maximize className="size-4" />{t("canvas.imagePreview.fit")}</button>
                    <button type="button" className={buttonClass} disabled={!size} aria-label={t("canvas.imagePreview.original")} title={t("canvas.imagePreview.original")} onClick={() => viewport.showOriginal()}>100%</button>
                    <button type="button" className={buttonClass} disabled={!size} aria-label={t("common.download")} title={t("common.download")} onClick={() => onDownload(batch.length ? image.id : undefined)}><Download className="size-4" /></button>
                </div>
            </div>
        </Modal>
    );
}
