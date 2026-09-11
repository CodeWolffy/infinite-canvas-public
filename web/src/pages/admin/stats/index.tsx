import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, DatePicker, Segmented, Select, Table } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { saveAs } from "file-saver";
import { Activity, CircleDollarSign, Clock3, Database, Download, Image, ListTodo, MessageSquareText, Send, Waypoints } from "lucide-react";

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
            <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
                <Metric icon={Database} label="对象存储" value={`${formatBytes(statsQuery.data.storage.totalBytes)} · ${statsQuery.data.storage.totalCount} 个文件`} />
                <Metric icon={Send} label="生成请求" value={totals?.requestCount || 0} />
                <Metric icon={Image} label="成功图片" value={totals?.successImageCount || 0} />
                <Metric icon={CircleDollarSign} label="生成消费" value={`¥${Number(totals?.estimatedCost || 0).toFixed(6)}`} />
                <Metric icon={Activity} label="任务成功率" value={percent(totals?.succeededTaskCount, totals?.requestCount)} />
                <Metric icon={Waypoints} label="渠道成功率" value={percent(totals?.succeededAttemptCount, totals?.attemptCount)} />
                <Metric icon={Clock3} label="平均耗时" value={duration(totals?.averageDurationMs || 0)} />
                <Metric icon={Clock3} label="P50 耗时" value={duration(totals?.p50DurationMs || 0)} />
                <Metric icon={Clock3} label="P95 耗时" value={duration(totals?.p95DurationMs || 0)} />
                <Metric icon={ListTodo} label="生成队列" value={`${statsQuery.data?.queue.queuedCount || 0} 排队 / ${statsQuery.data?.queue.runningCount || 0} 运行`} />
                <Metric icon={MessageSquareText} label="文本调用" value={`${statsQuery.data?.textTotals.succeededRequestCount || 0}/${statsQuery.data?.textTotals.requestCount || 0} 成功`} />
            </div>
            <div className="mt-5 grid gap-5 xl:grid-cols-2">
                <StatsTable title="按用户" loading={statsQuery.isLoading} rows={statsQuery.data?.byUsers || []} columns={[{ title: "用户", key: "user", render: (_, row) => <div><div className="font-medium">{row.displayName}</div><div className="text-xs text-stone-500">@{row.username}</div></div> }, ...taskColumns]} onExport={() => exportCsv(`按用户-${rangeTag}.csv`, statsQuery.data?.byUsers || [], [["displayName", "用户"], ["username", "账号"], ["requestCount", "请求数"], ["successImageCount", "成功图片"], ["estimatedCost", "生成消费"]])} />
                <StatsTable title="按模型" loading={statsQuery.isLoading} rows={statsQuery.data?.byModels || []} columns={[{ title: "模型", key: "model", render: (_, row) => <div><div className="font-medium">{row.displayName}</div><div className="text-xs text-stone-500">{row.name}</div></div> }, ...taskColumns]} onExport={() => exportCsv(`按模型-${rangeTag}.csv`, statsQuery.data?.byModels || [], [["displayName", "模型"], ["name", "标识"], ["requestCount", "请求数"], ["successImageCount", "成功图片"], ["estimatedCost", "生成消费"]])} />
            </div>
            <div className="mt-5"><StatsTable title="按渠道尝试" loading={statsQuery.isLoading} rows={statsQuery.data?.byChannels || []} columns={[{ title: "渠道", dataIndex: "name" }, { title: "尝试数", dataIndex: "attemptCount", width: 90, sorter: (a, b) => a.attemptCount - b.attemptCount }, { title: "成功数", dataIndex: "succeededAttemptCount", width: 90, sorter: (a, b) => a.succeededAttemptCount - b.succeededAttemptCount }, { title: "成功率", key: "rate", width: 90, render: (_, row) => percent(row.succeededAttemptCount, row.attemptCount) }, { title: "平均耗时", dataIndex: "averageDurationMs", width: 110, render: duration, sorter: (a, b) => a.averageDurationMs - b.averageDurationMs }, { title: "P50", dataIndex: "p50DurationMs", width: 100, render: duration }, { title: "P95", dataIndex: "p95DurationMs", width: 100, render: duration }]} /></div>
            </> : null}
        </div>
    );
}

const taskColumns = [
    { title: "请求数", dataIndex: "requestCount", width: 100, sorter: (a: { requestCount: number }, b: { requestCount: number }) => a.requestCount - b.requestCount },
    { title: "成功图片", dataIndex: "successImageCount", width: 110, sorter: (a: { successImageCount: number }, b: { successImageCount: number }) => a.successImageCount - b.successImageCount },
    { title: "生成消费", dataIndex: "estimatedCost", width: 120, render: (value: string) => `¥${Number(value || 0).toFixed(6)}`, sorter: (a: { estimatedCost: string }, b: { estimatedCost: string }) => Number(a.estimatedCost) - Number(b.estimatedCost) },
];

function Metric({ icon: Icon, label, value }: { icon: typeof Send; label: string; value: string | number }) {
    return <div className="rounded-xl border border-stone-200 bg-background p-3 dark:border-stone-800"><div className="flex items-center gap-2 text-xs text-stone-500"><Icon className="size-3.5" />{label}</div><div className="mt-2 text-xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">{value}</div></div>;
}

function StatsTable<T extends { id: string }>({ title, loading, rows, columns, onExport }: { title: string; loading: boolean; rows: T[]; columns: TableColumnsType<T>; onExport?: () => void }) {
    return (
        <section className="overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5 dark:border-stone-800">
                <span className="text-sm font-medium">{title}</span>
                {onExport && rows.length ? (
                    <Button type="text" size="small" icon={<Download className="size-3.5" />} onClick={onExport}>导出 CSV</Button>
                ) : null}
            </div>
            <Table<T> size="small" rowKey="id" dataSource={rows} columns={columns} loading={loading} pagination={false} />
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
