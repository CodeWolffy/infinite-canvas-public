import type { CanvasGenerationMode } from "@/types/canvas";
import type { useCanvasGenerationQuote } from "./use-canvas-generation-quote";

export function CanvasGenerationSummary({ mode, quote }: { mode: CanvasGenerationMode; quote: ReturnType<typeof useCanvasGenerationQuote> }) {
    return <div className="mt-2 text-[11px] leading-4" aria-live="polite">
        <p>本次 {quote.count} {mode === "image" ? "张图片" : mode === "text" ? "份文本" : mode === "video" ? "个视频" : "段音频"}{quote.quote ? <> · {mode === "text" && quote.count > 1 ? "每份" : ""}预计冻结 <span className="font-medium tabular-nums">¥{quote.quote.estimatedHold}</span></> : null}</p>
        {quote.reason ? <p className="mt-0.5">{quote.reason}{quote.error ? <button type="button" className="ml-1 rounded px-1 underline underline-offset-2 hover:bg-black/5 dark:hover:bg-white/10" disabled={quote.isFetching} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void quote.refetch(); }}>重新获取费用</button> : null}</p> : null}
        {quote.needsPreparation ? <button type="button" className="mt-1 rounded px-1 underline underline-offset-2 hover:bg-black/5 dark:hover:bg-white/10" disabled={quote.preparingMedia} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void quote.prepareMedia(); }}>{quote.preparingMedia ? "正在准备素材…" : "准备素材并获取费用"}</button> : null}
        <p className="mt-0.5 opacity-60">冻结不是最终扣费，完成后按实际费用结算。</p>
    </div>;
}
