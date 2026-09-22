import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "antd";
import { RotateCw, TriangleAlert } from "lucide-react";

// 发版后旧 chunk 会被 404，动态导入失败时自动刷新一次即可拿到新版本。
const CHUNK_RELOAD_KEY = "infinite-canvas:chunk-reload";

function isChunkLoadError(error: unknown) {
    if (error instanceof Error && error.name === "ChunkLoadError") return true;
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /Failed to fetch dynamically imported module|Importing a module script failed/i.test(message);
}

function reloadOnce() {
    try {
        if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return;
        sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
    } catch {
        // 隐私模式下 sessionStorage 不可用，直接刷新一次。
    }
    window.location.reload();
}

/** 错误页 UI：渲染异常与路由错误共用同一个提示与刷新入口。 */
export function AppErrorFallback({ message }: { message?: string }) {
    return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
            <TriangleAlert className="size-8 text-amber-500" />
            <h1 className="text-lg font-semibold">页面出现错误</h1>
            <p className="max-w-md text-sm leading-6 text-muted-foreground">{message || "页面加载或渲染时发生异常。刷新后通常可以恢复；如果反复出现，请联系管理员。"}</p>
            <Button type="primary" icon={<RotateCw className="size-4" />} onClick={() => window.location.reload()}>
                刷新页面
            </Button>
        </div>
    );
}

type AppErrorBoundaryProps = { children: ReactNode };
type AppErrorBoundaryState = { failed: boolean };

/** 全局错误兜底：渲染失败时给出可见提示，避免整页白屏。 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { failed: false };

    static getDerivedStateFromError(): AppErrorBoundaryState {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("页面渲染失败", error, info.componentStack);
        if (isChunkLoadError(error)) reloadOnce();
    }

    render() {
        return this.state.failed ? <AppErrorFallback /> : this.props.children;
    }
}
