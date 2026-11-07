import { Button } from "antd";
import { LoaderCircle, RotateCcw, X } from "lucide-react";
import type { ReferenceUpload } from "@/hooks/use-workbench-reference-uploads";

export function ReferenceUploadFeedback({ uploads, onRetry, onRemove }: { uploads: ReferenceUpload[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
    if (!uploads.length) return null;
    return <ul className="mt-2 space-y-2 text-xs" aria-live="polite" aria-label="参考素材上传状态">
        {uploads.map((item) => <li key={item.id} className="flex items-start gap-2 rounded-md border border-border px-2 py-2">
            {item.status === "preparing" || item.status === "uploading" ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
            <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={item.name}>{item.name}</p>
                <p className={`mt-1 break-words leading-5 ${item.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{item.status === "failed" ? item.error : item.status === "preparing" ? "正在准备…" : item.status === "uploading" ? "正在上传…" : "上传完成，等待前面的文件处理完成"}</p>
            </div>
            {item.status === "failed" && item.retryable ? <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => onRetry(item.id)} aria-label={`重试上传 ${item.name}`}>重试</Button> : null}
            <Button type="text" size="small" icon={<X className="size-3.5" />} onClick={() => onRemove(item.id)} aria-label={`移除上传 ${item.name}`} />
        </li>)}
    </ul>;
}
