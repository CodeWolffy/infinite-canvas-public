import { Button } from "antd";

export function GenerationFailureCard({ error, onRetry, video = false }: { error: string; onRetry: () => void; video?: boolean }) {
    const reason = error.trim().split(/\r?\n/, 1)[0] || "生成请求未完成，请查看错误详情";
    return <div className="overflow-hidden rounded-lg border border-destructive/25 bg-destructive/5">
        <div className={`flex ${video ? "min-h-52" : "min-h-44"} flex-col justify-center gap-3 p-5`}>
            <p className="text-sm font-medium text-destructive">生成失败</p>
            <p className="line-clamp-2 break-words text-sm leading-5 text-destructive" role="alert">{reason}</p>
            <p className="text-xs leading-5 text-muted-foreground">可以按原参数重试；也可以先「用此批次再创作」，调整提示词、模型或参考素材后重新生成。</p>
            <details className="text-xs">
                <summary className="cursor-pointer text-destructive">查看错误详情</summary>
                <p className="mt-2 whitespace-pre-wrap break-words leading-5 text-muted-foreground">{error}</p>
            </details>
            <p className="text-xs leading-5 text-muted-foreground">费用结算请以账户账单记录为准。</p>
        </div>
        <div className="flex justify-end border-t border-destructive/20 p-3"><Button size="small" danger onClick={onRetry}>按原参数重试</Button></div>
    </div>;
}
