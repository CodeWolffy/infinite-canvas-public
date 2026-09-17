import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Segmented, Skeleton, Tooltip } from "antd";
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import dayjs from "dayjs";

import { getPublicStatus, type ModelAvailability } from "@/services/api/platform-operations";
import { useUserStore } from "@/stores/use-user-store";

const states = {
    available: { text: "正常", dot: "bg-emerald-500", ping: "bg-emerald-400" },
    degraded: { text: "部分可用", dot: "bg-amber-500", ping: "bg-amber-400" },
    unavailable: { text: "不可用", dot: "bg-rose-500", ping: "bg-rose-400" },
    unknown: { text: "待检测", dot: "bg-slate-400 dark:bg-zinc-500", ping: "bg-slate-300" },
} as const;
const capabilities: Record<string, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };
const barLimit = 40;

const percent = (value: number) => (value >= 1 ? "100%" : `${(value * 100).toFixed(1)}%`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export default function StatusPage() {
    const session = useUserStore((state) => state.sessionVersion);
    const [capability, setCapability] = useState("all");
    const [autoRefresh, setAutoRefresh] = useState(true);
    const query = useQuery({
        queryKey: ["public-model-status", session],
        queryFn: getPublicStatus,
        retry: false,
        refetchInterval: autoRefresh ? 60000 : false,
    });
    const models = query.data?.models || [];
    const filtered = models.filter((model) => capability === "all" || model.capability === capability);

    const modelsWithUptime = models.filter((m) => m.uptime != null);
    const overallUptime = modelsWithUptime.length > 0
        ? modelsWithUptime.reduce((sum, m) => sum + (m.uptime || 0), 0) / modelsWithUptime.length
        : null;

    const allValidDurations = models.flatMap((m) => (m.checks || []).map((c) => c.durationMs).filter((d): d is number => d != null && d > 0));
    const overallAvgMs = allValidDurations.length > 0
        ? Math.round(allValidDurations.reduce((a, b) => a + b, 0) / allValidDurations.length)
        : null;

    return <main className="h-full overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto w-full max-w-6xl space-y-6">
            <section>
                <div className="flex items-center gap-2 text-stone-500 mb-1">
                    <Activity className="size-4 text-emerald-500" />
                    <span className="text-xs font-semibold uppercase tracking-wider">System Status</span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">模型运行状态</h1>
                <p className="mt-1 text-sm text-stone-500">
                    实时监控各 AI 模型的可用状态与响应性能，数据基于近 24 小时服务表现动态更新。
                </p>
            </section>

            {query.data ? <Banner models={models} /> : null}

            {query.data && models.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-xl border border-border bg-card p-4 shadow-2xs">
                        <p className="text-xs text-muted-foreground">监控模型服务</p>
                        <p className="mt-1.5 font-mono text-2xl font-semibold tracking-tight">{models.length}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4 shadow-2xs">
                        <p className="text-xs text-muted-foreground">服务健康率</p>
                        <p className="mt-1.5 font-mono text-2xl font-semibold tracking-tight text-emerald-600 dark:text-emerald-400">
                            {models.length > 0 ? percent(models.filter((m) => m.status !== "unavailable").length / models.length) : "100%"}
                        </p>
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4 shadow-2xs">
                        <p className="text-xs text-muted-foreground">24h 总体成功率</p>
                        <p className="mt-1.5 font-mono text-2xl font-semibold tracking-tight">
                            {overallUptime != null ? percent(overallUptime) : "100%"}
                        </p>
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4 shadow-2xs">
                        <p className="text-xs text-muted-foreground">平均响应耗时</p>
                        <p className="mt-1.5 font-mono text-2xl font-semibold tracking-tight">
                            {overallAvgMs != null ? seconds(overallAvgMs) : "—"}
                        </p>
                    </div>
                </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <Segmented
                    value={capability}
                    onChange={(value) => setCapability(String(value))}
                    options={[{ value: "all", label: "全部模型" }, ...Object.entries(capabilities).map(([value, label]) => ({ value, label }))]}
                />
                <div className="flex items-center gap-3">
                    <span className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
                        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3.5 w-1 rounded-[1px] bg-emerald-500" />成功</span>
                        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3.5 w-1 rounded-[1px] bg-rose-500" />失败</span>
                        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3.5 w-1 rounded-[1px] border border-border bg-zinc-100 dark:bg-zinc-800" />无记录</span>
                    </span>
                    <button
                        type="button"
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition ${
                            autoRefresh
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium"
                                : "border-border text-muted-foreground hover:bg-muted"
                        }`}
                        title={autoRefresh ? "点击暂停 60s 自动刷新" : "点击开启 60s 自动刷新"}
                    >
                        <span className={`size-1.5 rounded-full ${autoRefresh ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/50"}`} />
                        {autoRefresh ? "60s 自动更新" : "自动更新已关"}
                    </button>
                    <Button
                        type="text"
                        icon={<RefreshCw className={`size-4 ${query.isFetching ? "animate-spin" : ""}`} />}
                        loading={query.isFetching}
                        onClick={() => void query.refetch()}
                    >
                        刷新状态
                    </Button>
                </div>
            </div>

            {query.error ? <Alert type="error" showIcon title="暂时无法读取模型状态" description={query.error.message} /> : null}

            {query.isPending ? (
                <Skeleton active paragraph={{ rows: 6 }} />
            ) : filtered.length === 0 && !query.error ? (
                <div className="rounded-2xl border border-border bg-card p-12 text-center text-sm text-muted-foreground shadow-2xs">
                    暂无该分类下的模型
                </div>
            ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                    {filtered.map((model) => <ModelRow key={model.id} model={model} />)}
                </div>
            )}
        </div>
    </main>;
}

function Banner({ models }: { models: ModelAvailability[] }) {
    const unavailable = models.filter((m) => m.status === "unavailable").length;
    const degraded = models.filter((m) => m.status === "degraded").length;

    if (unavailable > 0) {
        return (
            <div className="flex items-center gap-3.5 rounded-2xl border border-rose-500/30 bg-rose-500/[0.08] p-4 sm:p-5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-400">
                    <AlertCircle className="size-5" />
                </div>
                <div>
                    <h2 className="text-base font-semibold text-rose-950 dark:text-rose-100">{unavailable} 个模型当前不可用</h2>
                    <p className="mt-0.5 text-xs text-rose-800/80 dark:text-rose-300/80">
                        {degraded > 0 ? `另有 ${degraded} 个模型服务出现波动，技术团队正在排障与自动调度中。` : "技术团队正在处理排障，其余模型服务保持正常。"}
                    </p>
                </div>
            </div>
        );
    }

    if (degraded > 0) {
        return (
            <div className="flex items-center gap-3.5 rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] p-4 sm:p-5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-5" />
                </div>
                <div>
                    <h2 className="text-base font-semibold text-amber-950 dark:text-amber-100">{degraded} 个模型服务出现波动</h2>
                    <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">部分服务可能存在轻微延迟，系统正在自动调度可用线路。</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3.5 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.08] p-4 sm:p-5 dark:border-emerald-500/30 dark:bg-emerald-500/[0.12]">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400">
                <CheckCircle2 className="size-5" />
            </div>
            <div>
                <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-emerald-950 dark:text-emerald-100">所有模型服务运行正常</h2>
                    <span className="relative flex size-2">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                    </span>
                </div>
                <p className="mt-0.5 text-xs text-emerald-800/80 dark:text-emerald-300/80">近 24 小时服务保持高可用，AI 模型推理与生成按预期运行。</p>
            </div>
        </div>
    );
}

function ModelRow({ model }: { model: ModelAvailability }) {
    const checks = model.checks || [];
    const latest = checks[checks.length - 1];
    const isWorking = model.status === "available" || ((model.uptime ?? 0) > 0);
    const state = isWorking ? states.available : states[model.status];
    const validDurations = checks.map((c) => c.durationMs).filter((d): d is number => d != null && d > 0);
    const avgMs = validDurations.length > 0 ? Math.round(validDurations.reduce((a, b) => a + b, 0) / validDurations.length) : null;

    return <div className="rounded-2xl border border-border bg-card p-5 sm:p-6 shadow-2xs transition-colors hover:bg-muted/20">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 items-center gap-2.5">
                <span className="relative flex size-2.5 shrink-0">
                    <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${state.ping}`} />
                    <span className={`relative inline-flex size-2.5 rounded-full ${state.dot}`} />
                </span>
                <span className="truncate text-base font-medium tracking-tight">{model.displayName}</span>
                <span className="rounded-md border border-border/80 bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {capabilities[model.capability] || model.capability}
                </span>
                {model.availableChannels > 0 ? (
                    <span className="hidden rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 sm:inline-block">
                        {model.availableChannels} 条线路可用
                    </span>
                ) : null}
            </div>
            {model.uptime == null ? (
                <span className="shrink-0 text-xs text-muted-foreground/80">{model.status === "available" ? "通道就绪 · 待调用" : "暂无请求"}</span>
            ) : (
                <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-base sm:text-lg font-semibold tracking-tight">{percent(model.uptime)}</span>
                    <span className="text-xs text-muted-foreground">24h 成功率</span>
                </div>
            )}
        </div>

        <div className="mt-3.5 flex w-full items-center gap-[2px] sm:gap-[3px]">
            {checks.length === 0 ? (
                Array.from({ length: barLimit }).map((_, index) => (
                    <Tooltip key={`empty-${index}`} title="24 小时内暂无请求记录">
                        <span className="h-7 sm:h-8 flex-1 min-w-[3px] max-w-[10px] rounded-[2px] border border-border/40 bg-zinc-100/90 hover:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-800/80 dark:hover:bg-zinc-700 transition-all" />
                    </Tooltip>
                ))
            ) : (
                <>
                    {Array.from({ length: barLimit - checks.length }).map((_, index) => (
                        <span key={`empty-${index}`} className="h-7 sm:h-8 flex-1 min-w-[3px] max-w-[10px] rounded-[2px] border border-border/40 bg-zinc-100/90 dark:border-zinc-800 dark:bg-zinc-800/80" />
                    ))}
                    {checks.map((check, index) => (
                        <Tooltip
                            key={index}
                            title={`${dayjs(check.finishedAt).format("MM-DD HH:mm:ss")} · ${check.status === "succeeded" ? "请求成功" : "请求失败"}${check.durationMs == null ? "" : ` · 耗时 ${seconds(check.durationMs)}`}`}
                        >
                            <span
                                className={`h-7 sm:h-8 flex-1 min-w-[3px] max-w-[10px] rounded-[2px] shadow-2xs transition-all hover:scale-y-105 hover:opacity-90 ${
                                    check.status === "succeeded" ? "bg-emerald-500" : "bg-rose-500"
                                }`}
                            />
                        </Tooltip>
                    ))}
                </>
            )}
        </div>

        <div className="mt-2.5 flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-mono text-[11px] text-muted-foreground/60">24 小时前</span>
            <div className="flex flex-wrap items-center justify-center gap-2">
                {checks.length > 0 ? (
                    <>
                        <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{checks.length}</span> 笔样本
                        </span>
                        {avgMs != null ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                                平均耗时 <span className="font-mono font-medium text-foreground">{seconds(avgMs)}</span>
                            </span>
                        ) : null}
                        {latest ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                                最新请求 <span className="font-medium text-foreground">{dayjs(latest.finishedAt).format("HH:mm:ss")}</span>
                                {latest.durationMs != null ? <span className="font-mono text-muted-foreground/80">({seconds(latest.durationMs)})</span> : null}
                            </span>
                        ) : null}
                    </>
                ) : (
                    <span className="rounded-md bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground/70">
                        {isWorking ? "服务线路就绪 · 近 24 小时暂无调用记录" : "近 24 小时暂无请求记录"}
                    </span>
                )}
            </div>
            <span className="font-mono text-[11px] text-muted-foreground/60">当前</span>
        </div>
    </div>;
}
