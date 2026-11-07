import { ImagePlus, LayoutTemplate, Upload } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const example = "一只橘猫坐在窗边的木桌上，午后阳光穿过白色纱帘，温暖柔和的水彩插画";

export function CanvasEmptyGuide({ onDescribe, onUpload, onTemplates }: { onDescribe: (prompt?: string) => void; onUpload: () => void; onTemplates: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return <div data-canvas-no-zoom className="pointer-events-none absolute inset-x-0 bottom-[calc(9rem+env(safe-area-inset-bottom))] top-[calc(4rem+env(safe-area-inset-top))] z-20 flex items-center justify-center px-4 @min-[1024px]/canvas:bottom-24 @min-[1024px]/canvas:top-20 @min-[1024px]/canvas:px-6" style={{ color: theme.node.text }}>
        <div className="thin-scrollbar pointer-events-auto max-h-full w-full max-w-lg overflow-y-auto overscroll-contain text-center" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <h2 className="text-xl font-medium tracking-wide">从一个想法开始</h2>
            <p className="mt-2 text-sm" style={{ color: theme.node.muted }}>描述画面、带入素材，或从已有模板开始创作</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
                <button type="button" className="inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => onDescribe()}><ImagePlus className="size-4" />描述生成图片</button>
                <button type="button" className="inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10" onClick={onUpload}><Upload className="size-4" />上传素材</button>
                <button type="button" className="inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10" onClick={onTemplates}><LayoutTemplate className="size-4" />使用模板</button>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: theme.node.muted }}>上传图片后可继续编辑 · 使用模板会创建新画布</p>
            <button type="button" className="mt-7 max-w-md rounded-lg px-4 py-3 text-left text-xs leading-6 transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => onDescribe(example)}>
                <span className="mb-0.5 block font-medium" style={{ color: theme.node.text }}>试试这个描述 →</span>
                {example}
                <span className="mt-1 block opacity-70">仅填入提示词，确认后再生成</span>
            </button>
        </div>
    </div>;
}
