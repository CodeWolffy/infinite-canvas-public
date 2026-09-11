import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, DatePicker, Segmented, Select, Table } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { saveAs } from "file-saver";
import { Activity, CircleDollarSign, Clock3, Database, Download, Image, ListTodo, MessageSquareText, PieChart, Send, TrendingUp, Waypoints } from "lucide-react";

import { getAdminUsers } from "@/services/api/admin-users";
import { getAdminChannels, getAdminModels, getAdminStats } from "@/services/api/admin-platform";
import { formatBytes } from "@/lib/image-utils";

type Filters = { range: [Dayjs, Dayjs]; userId?: string; modelId?: string; channelId?: string };

export default function AdminStatsPage() {
    const [filters, setFilters] = useState<Filters>(() => ({ range: [dayjs().startOf("day"), dayjs().startOf("day")] }));
    const [preset, setPresetState] = useState<number | null>(1);
    const usersQuery = useQuery({ queryKey: ["admin", "users"], queryFn: getAdminUsers });
    const modelsQuery = useQuery({ queryKey: ["admin", "models"], queryFn: getAdminModels });
    const channelsQuery = useQuery({ queryKey: ["admin", "channels"], queryFn: getAdminChannels });
    const statsQuery = useQuery({
        queryKey: ["admin", "stats", filters.range[0].toISOString(), filters.range[1].toISOString(), filters.userId, filters.modelId, filters.channelId],
        queryFn: () => getAdminStats({ from: filters.range[0].startOf("day").toISOString(), to: filters.range[1].add(1, "day").startOf("day").toISOString(), userId: filters.userId, modelId: filters.modelId, channelId: filters.channelId }),
        staleTime: 0,
        refetchOnMount: "always",
        refetchOnWindowFocus: true,
        refetchInterval: (query) => ((query.state.data?.queue.queuedCount || 0) > 0 ? 5000 : false),
    });
    const totals = statsQuery.data?.totals;
    const setPreset = (days: number) => { setPresetState(days); setFilters((current) => ({ ...current, range: [dayjs().subtract(days - 1, "day").startOf("day"), dayjs().startOf("day")] })); };
    const updateFilters = <K extends keyof Filters>(key: K, value: Filters[K]) => { if (key === "range") setPresetState(null); setFilters((current) => ({ ...current, [key]: value })); };
    const rangeTag = dayjs().format("YYYYMMDD");

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Usage overview</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">用量统计</h1><p className="mt-1 text-sm text-stone-500">按时间、用户、模型和渠道查看四类生成任务与生成消费。</p></div>
            <div className="mt-7 flex flex-wrap gap-3 rounded-xl border border-stone-200 bg-background p-4 dark:border-stone-800">
                <Segmented value={preset} options={[{ label: "今天", value: 1 }, { label: "近 7 天", value: 7 }, { label: "近 30 天", value: 30 }]} onChange={(value) => setPreset(Number(value))} />
                <DatePicker.RangePicker value={filters.range} allowClear={false} onChange={(range) => range && updateFilters("range", range as [Dayjs, Dayjs])} />
                <Select allowClear placeholder="全部用户" className="min-w-40" value={filters.userId} onChange={(userId) => updateFilters("userId", userId)} options={(usersQuery.data || []).map((user) => ({ value: user.id, label: user.displayName }))} />
                <Select allowClear placeholder="全部模型" className="min-w-44" value={filters.modelId} onChange={(modelId) => updateFilters("modelId", modelId)} options={(modelsQuery.data || []).map((model) => ({ value: model.id, label: model.displayName }))} />
                <Select allowClear placeholder="全部渠道" className="min-w-40" value={filters.channelId} onChange={(channelId) => updateFilters("channelId", channelId)} options={(channelsQuery.data || []).map((channel) => ({ value: channel.id, label: channel.name }))} />
            </div>
            {statsQuery.isError ? <Alert className="mt-5" type="error" showIcon message="用量统计加载失败" description={statsQuery.error.message || "请稍后重试"} /> : null}
            {statsQuery.data ? <>
            <div className="mt-5 grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                <Metric icon={Send} label="生成请求" value={totals?.requestCount || 0} />
                <Metric icon={Activity} label="任务成功率" value={percent(totals?.succeededTaskCount, totals?.requestCount)} />
                <Metric icon={Image} label="成功图片" value={totals?.successImageCount || 0} />
                <Metric icon={MessageSquareText} label="文本调用" value={`${statsQuery.data?.textTotals.succeededRequestCount || 0}/${statsQuery.data?.textTotals.requestCount || 0}`} sub="成功 / 总量" />
                <Metric icon={CircleDollarSign} label="生成预估消费" value={`¥${Number(totals?.estimatedCost || 0).toFixed(4)}`} />
                <Metric icon={Waypoints} label="渠道调用总数" value={`${totals?.attemptCount || 0} 次`} sub={`成功率 ${percent(totals?.succeededAttemptCount, totals?.attemptCount)}`} />
                <Metric icon={Clock3} label="平均耗时" value={duration(totals?.averageDurationMs || 0)} />
                <Metric icon={Clock3} label="P50 耗时" value={duration(totals?.p50DurationMs || 0)} />
                <Metric icon={Clock3} label="P95 耗时" value={duration(totals?.p95DurationMs || 0)} />
                <Metric icon={Database} label="对象存储" value={formatBytes(statsQuery.data.storage.totalBytes)} sub={`${statsQuery.data.storage.totalCount} 个文件`} />
                <Metric icon={ListTodo} label="生成队列" value={`${statsQuery.data?.queue.runningCount || 0} 运行`} sub={`${statsQuery.data?.queue.queuedCount || 0} 排队等待`} />
                <Metric icon={Waypoints} label="渠道重试/故障" value={`${(totals?.attemptCount || 0) - (totals?.succeededAttemptCount || 0)} 次`} sub="需关注上游稳定性" />
            </div>
            <div className="mt-6 grid gap-5 xl:grid-cols-3">
                <section className="overflow-hidden rounded-xl border border-stone-200 bg-background p-5 dark:border-stone-800 xl:col-span-2 shadow-sm flex flex-col justify-between">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-3 dark:border-stone-800">
                        <div className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100">
                            <TrendingUp className="size-4 text-blue-500" />
                            <span>每日调用与消费走势</span>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-stone-500">
                            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-blue-500" /> 请求数</span>
                            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" /> 消费 (¥)</span>
                        </div>
                    </div>
                    <DailyTrendsBoard dates={statsQuery.data.byDates || []} />
                </section>
                <section className="overflow-hidden rounded-xl border border-stone-200 bg-background p-5 dark:border-stone-800 shadow-sm flex flex-col justify-between">
                    <div className="flex items-center gap-2 border-b border-stone-200 pb-3 text-sm font-semibold text-stone-900 dark:text-stone-100 dark:border-stone-800">
                        <PieChart className="size-4 text-amber-500" />
                        <span>能力类别分布</span>
                    </div>
                    <CapabilityBreakdownBoard capabilities={statsQuery.data.byCapabilities || []} />
                </section>
            </div>
            <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <StatsTable
                    title="按用户排行"
                    loading={statsQuery.isLoading}
                    rows={statsQuery.data?.byUsers || []}
                    columns={[
                        {
                            title: "用户",
                            key: "user",
                            minWidth: 180,
                            render: (_, row) => (
                                <div className="min-w-0">
                                    <div className="font-medium text-stone-900 dark:text-stone-100 truncate">{row.displayName}</div>
                                    <div className="text-xs text-stone-400 font-mono truncate">@{row.username}</div>
                                </div>
                            ),
                        },
                        ...taskColumns,
                    ]}
                    onExport={() => exportCsv(`按用户-${rangeTag}.csv`, statsQuery.data?.byUsers || [], [["displayName", "用户"], ["username", "账号"], ["requestCount", "请求数"], ["successImageCount", "成功图片"], ["estimatedCost", "生成消费"]])}
                />
                <StatsTable
                    title="按模型排行"
                    loading={statsQuery.isLoading}
                    rows={statsQuery.data?.byModels || []}
                    columns={[
                        {
                            title: "模型",
                            key: "model",
                            minWidth: 180,
                            render: (_, row) => (
                                <div className="min-w-0">
                                    <div className="font-medium text-stone-900 dark:text-stone-100 truncate">{row.displayName}</div>
                                    <div className="text-xs text-stone-400 font-mono truncate">{row.name}</div>
                                </div>
                            ),
                        },
                        ...taskColumns,
                    ]}
                    onExport={() => exportCsv(`按模型-${rangeTag}.csv`, statsQuery.data?.byModels || [], [["displayName", "模型"], ["name", "标识"], ["requestCount", "请求数"], ["successImageCount", "成功图片"], ["estimatedCost", "生成消费"]])}
                />
            </div>
            <div className="mt-6">
                <StatsTable
                    title="按渠道尝试与质量统计"
                    loading={statsQuery.isLoading}
                    rows={statsQuery.data?.byChannels || []}
                    columns={[
                        {
                            title: "渠道名称",
                            dataIndex: "name",
                            minWidth: 200,
                            render: (value: string) => (
                                <span className="font-medium text-stone-900 dark:text-stone-100">{value}</span>
                            ),
                        },
                        {
                            title: "尝试数",
                            dataIndex: "attemptCount",
                            width: 120,
                            align: "right" as const,
                            sorter: (a, b) => a.attemptCount - b.attemptCount,
                            render: (v: number) => <span className="font-mono font-medium">{v?.toLocaleString() || 0}</span>,
                        },
                        {
                            title: "成功数",
                            dataIndex: "succeededAttemptCount",
                            width: 120,
                            align: "right" as const,
                            sorter: (a, b) => a.succeededAttemptCount - b.succeededAttemptCount,
                            render: (v: number) => <span className="font-mono text-emerald-600 dark:text-emerald-400 font-medium">{v?.toLocaleString() || 0}</span>,
                        },
                        {
                            title: "成功率",
                            key: "rate",
                            width: 180,
                            align: "center" as const,
                            sorter: (a, b) => {
                                const rateA = a.attemptCount ? a.succeededAttemptCount / a.attemptCount : 0;
                                const rateB = b.attemptCount ? b.succeededAttemptCount / b.attemptCount : 0;
                                return rateA - rateB;
                            },
                            render: (_, row) => {
                                const rateVal = row.attemptCount ? (row.succeededAttemptCount / row.attemptCount) * 100 : 0;
                                const barColor = rateVal >= 95 ? "bg-emerald-500" : rateVal >= 80 ? "bg-amber-500" : "bg-rose-500";
                                return (
                                    <div className="flex items-center justify-center gap-2">
                                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
                                            <div className={`h-full ${barColor}`} style={{ width: `${rateVal}%` }} />
                                        </div>
                                        <span className="font-mono text-xs font-semibold text-stone-800 dark:text-stone-200">
                                            {percent(row.succeededAttemptCount, row.attemptCount)}
                                        </span>
                                    </div>
                                );
                            },
                        },
                        {
                            title: "平均耗时",
                            dataIndex: "averageDurationMs",
                            width: 130,
                            align: "right" as const,
                            render: (v: number) => <span className="font-mono text-stone-600 dark:text-stone-300">{duration(v)}</span>,
                            sorter: (a, b) => a.averageDurationMs - b.averageDurationMs,
                        },
                        {
                            title: "P50",
                            dataIndex: "p50DurationMs",
                            width: 110,
                            align: "right" as const,
                            render: (v: number) => <span className="font-mono text-stone-500">{duration(v)}</span>,
                        },
                        {
                            title: "P95",
                            dataIndex: "p95DurationMs",
                            width: 110,
                            align: "right" as const,
                            render: (v: number) => <span className="font-mono text-stone-500">{duration(v)}</span>,
                        },
                    ]}
                    onExport={() => exportCsv(`按渠道-${rangeTag}.csv`, statsQuery.data?.byChannels || [], [["name", "渠道"], ["attemptCount", "尝试数"], ["succeededAttemptCount", "成功数"], ["averageDurationMs", "平均耗时(ms)"], ["p50DurationMs", "P50(ms)"], ["p95DurationMs", "P95(ms)"]])}
                />
            </div>
            </> : null}
        </div>
    );
}

const taskColumns = [
    { title: "请求数", dataIndex: "requestCount", width: 120, align: "right" as const, sorter: (a: { requestCount: number }, b: { requestCount: number }) => a.requestCount - b.requestCount, render: (v: number) => <span className="font-mono font-medium">{v?.toLocaleString() || 0}</span> },
    { title: "成功图片", dataIndex: "successImageCount", width: 120, align: "right" as const, sorter: (a: { successImageCount: number }, b: { successImageCount: number }) => a.successImageCount - b.successImageCount, render: (v: number) => <span className="font-mono text-emerald-600 dark:text-emerald-400">{v?.toLocaleString() || 0}</span> },
    { title: "生成消费", dataIndex: "estimatedCost", width: 140, align: "right" as const, render: (value: string) => <span className="font-mono font-semibold text-stone-900 dark:text-stone-100">¥{Number(value || 0).toFixed(4)}</span>, sorter: (a: { estimatedCost: string }, b: { estimatedCost: string }) => Number(a.estimatedCost) - Number(b.estimatedCost) },
];

function Metric({ icon: Icon, label, value, sub }: { icon: typeof Send; label: string; value: string | number; sub?: string }) {
    return (
        <div className="flex flex-col justify-between rounded-xl border border-stone-200 bg-background p-3.5 shadow-sm dark:border-stone-800">
            <div className="flex items-center gap-2 text-xs text-stone-500">
                <Icon className="size-3.5 shrink-0 text-stone-400" />
                <span className="truncate">{label}</span>
            </div>
            <div className="mt-2">
                <div className="truncate text-xl font-bold tracking-tight text-stone-950 dark:text-stone-100">{value}</div>
                {sub ? <div className="mt-0.5 truncate text-[11px] text-stone-400">{sub}</div> : null}
            </div>
        </div>
    );
}

function StatsTable<T extends { id: string }>({ title, loading, rows, columns, onExport }: { title: string; loading: boolean; rows: T[]; columns: TableColumnsType<T>; onExport?: () => void }) {
    return (
        <section className="overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800 shadow-sm">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">{title}</span>
                {onExport && rows.length ? (
                    <Button type="text" size="small" icon={<Download className="size-3.5" />} onClick={onExport} className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100">导出 CSV</Button>
                ) : null}
            </div>
            <Table<T> size="middle" rowKey="id" dataSource={rows} columns={columns} loading={loading} pagination={false} scroll={{ x: "max-content" }} />
        </section>
    );
}

function exportCsv(filename: string, rows: Record<string, unknown>[], headers: [string, string][]) {
    const lines = [
        headers.map(([, title]) => `"${title}"`).join(","),
        ...rows.map((row) => headers.map(([key]) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`).join(",")),
    ];
    saveAs(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), filename);
}

function percent(value = 0, total = 0) { return total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%"; }
function duration(milliseconds: number) { return milliseconds >= 60_000 ? `${(milliseconds / 60_000).toFixed(1)} 分` : `${(milliseconds / 1000).toFixed(1)} 秒`; }

function DailyTrendsBoard({ dates }: { dates: Array<{ date: string; requestCount: number; succeededCount: number; failedCount: number; successImageCount: number; estimatedCost: string }> }) {
    if (!dates.length) {
        return <div className="py-16 text-center text-xs text-stone-400">所选时间范围内暂无时间走势数据</div>;
    }
    const maxRequests = Math.max(...dates.map((d) => d.requestCount), 1);
    const maxCost = Math.max(...dates.map((d) => Number(d.estimatedCost) || 0), 0.001);

    return (
        <div className="mt-4 flex flex-col justify-end">
            <div className="relative flex h-52 items-end gap-2 overflow-x-auto pb-6 pt-6 px-2">
                {/* 背景参考虚线 */}
                <div className="absolute inset-x-0 top-6 border-b border-dashed border-stone-200/70 dark:border-stone-800 pointer-events-none" />
                <div className="absolute inset-x-0 top-1/2 border-b border-dashed border-stone-200/50 dark:border-stone-800/60 pointer-events-none" />

                {dates.map((d) => {
                    const reqHeight = Math.max((d.requestCount / maxRequests) * 100, 4);
                    const costVal = Number(d.estimatedCost) || 0;
                    const costHeight = Math.max((costVal / maxCost) * 100, 2);
                    return (
                        <div key={d.date} className="group relative flex min-w-[38px] flex-1 flex-col items-center justify-end h-full">
                            {/* Hover 浮层 */}
                            <div className="absolute -top-12 hidden whitespace-nowrap rounded-lg bg-stone-900 px-2.5 py-1.5 text-[11px] text-white shadow-xl group-hover:block z-30 dark:bg-stone-100 dark:text-stone-900 pointer-events-none">
                                <div className="font-semibold">{d.date}</div>
                                <div className="text-blue-300 dark:text-blue-600">请求: {d.requestCount} (成功 {d.succeededCount})</div>
                                <div className="text-emerald-300 dark:text-emerald-600">消费: ¥{costVal.toFixed(4)}</div>
                            </div>
                            <div className="flex items-end gap-1.5 w-full justify-center h-full pb-1">
                                <div style={{ height: `${reqHeight}%` }} className="w-3 rounded-t-sm bg-blue-500 hover:bg-blue-600 transition-all cursor-pointer shadow-sm" />
                                <div style={{ height: `${costHeight}%` }} className="w-2.5 rounded-t-sm bg-emerald-500 hover:bg-emerald-600 transition-all cursor-pointer shadow-sm" />
                            </div>
                            <span className="absolute bottom-0 text-[10px] text-stone-400 font-mono truncate w-full text-center">
                                {d.date.slice(5)}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

const CAPABILITY_NAMES: Record<string, string> = {
    image: "图像生成",
    text: "文本对话",
    video: "视频生成",
    audio: "音频合成",
    probe: "渠道探测",
    unknown: "其他调用",
};

const CAPABILITY_COLORS: Record<string, string> = {
    image: "bg-indigo-500",
    text: "bg-emerald-500",
    video: "bg-purple-500",
    audio: "bg-amber-500",
    probe: "bg-stone-400",
    unknown: "bg-stone-300",
};

function CapabilityBreakdownBoard({ capabilities }: { capabilities: Array<{ capability: string; requestCount: number; succeededCount: number; estimatedCost: string }> }) {
    if (!capabilities.length) {
        return <div className="py-16 text-center text-xs text-stone-400">暂无类别统计数据</div>;
    }
    const totalRequests = capabilities.reduce((acc, c) => acc + c.requestCount, 0) || 1;

    return (
        <div className="mt-4 space-y-4">
            <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800 p-0.5">
                {capabilities.map((c) => {
                    const ratio = (c.requestCount / totalRequests) * 100;
                    if (ratio < 0.5) return null;
                    return (
                        <div
                            key={c.capability}
                            style={{ width: `${ratio}%` }}
                            className={`${CAPABILITY_COLORS[c.capability] || "bg-sky-500"} first:rounded-l-full last:rounded-r-full transition-all`}
                            title={`${CAPABILITY_NAMES[c.capability] || c.capability}: ${c.requestCount} (${ratio.toFixed(1)}%)`}
                        />
                    );
                })}
            </div>
            <div className="divide-y divide-stone-100 dark:divide-stone-800 pt-1">
                {capabilities.map((c) => {
                    const ratio = percent(c.requestCount, totalRequests);
                    return (
                        <div key={c.capability} className="flex items-center justify-between py-2.5 text-xs">
                            <div className="flex items-center gap-2.5">
                                <span className={`size-2.5 rounded-full ${CAPABILITY_COLORS[c.capability] || "bg-sky-500"}`} />
                                <span className="font-semibold text-stone-800 dark:text-stone-200">
                                    {CAPABILITY_NAMES[c.capability] || c.capability}
                                </span>
                            </div>
                            <div className="flex items-center gap-4">
                                <span className="text-stone-600 dark:text-stone-300 font-mono font-medium">{c.requestCount.toLocaleString()} 次 ({ratio})</span>
                                <span className="text-stone-900 dark:text-stone-100 font-mono font-semibold w-24 text-right">¥{Number(c.estimatedCost || 0).toFixed(4)}</span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
