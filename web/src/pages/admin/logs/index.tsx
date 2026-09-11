import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, DatePicker, Segmented, Select, Table, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { RefreshCw, Trash2 } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { clearAdminRequestLogs, getAdminChannels, getAdminModels, getAdminRequestLogs, type RequestLog } from "@/services/api/admin-platform";
import { getAdminUsers } from "@/services/api/admin-users";

type Filters = { range: [Dayjs, Dayjs]; userId?: string; modelId?: string; channelId?: string; type?: RequestLog["type"]; status?: RequestLog["status"] };
const typeLabels = { image: "生图", text: "文本", video: "视频", audio: "音频", probe: "探测" } as const;
const statusLabels = { running: "运行中", succeeded: "成功", failed: "错误" } as const;

export default function AdminRequestLogsPage() {
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const queryClient = useQueryClient();
    const [filters, setFilters] = useState<Filters>(() => ({ range: [dayjs().startOf("day"), dayjs()] }));
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [preset, setPreset] = useState<number | null>(1);
    const usersQuery = useQuery({ queryKey: ["admin", "users"], queryFn: getAdminUsers });
    const modelsQuery = useQuery({ queryKey: ["admin", "models"], queryFn: getAdminModels });
    const channelsQuery = useQuery({ queryKey: ["admin", "channels"], queryFn: getAdminChannels });
    const logsQuery = useQuery({
        queryKey: ["admin", "request-logs", filters.range[0].toISOString(), filters.range[1].toISOString(), filters.userId, filters.modelId, filters.channelId, filters.type, filters.status, page, pageSize],
        queryFn: () => getAdminRequestLogs({
            from: filters.range[0].toISOString(),
            to: filters.range[1].toISOString(),
            userId: filters.userId,
            modelId: filters.modelId,
            channelId: filters.channelId,
            type: filters.type,
            status: filters.status,
            limit: pageSize,
            offset: (page - 1) * pageSize,
        }),
        refetchInterval: (query) => (query.state.data?.logs.some((log) => log.status === "running") ? 5000 : false),
    });
    const clearMutation = useMutation({
        mutationFn: clearAdminRequestLogs,
        onSuccess: (deleted) => { void queryClient.invalidateQueries({ queryKey: ["admin", "request-logs"] }); message.success(`已清空 ${deleted} 条日志`); },
        onError: (error: Error) => message.error(error.message || "操作失败"),
    });
    const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => { setPage(1); if (key === "range") setPreset(null); setFilters((current) => ({ ...current, [key]: value })); };

    const columns: TableColumnsType<RequestLog> = [
        { title: "时间", key: "time", width: 190, render: (_, log) => <div><div>{dayjs(log.startedAt).format("YYYY-MM-DD HH:mm:ss")}</div><div className={log.status === "succeeded" ? "text-emerald-600" : log.status === "failed" ? "text-red-500" : "text-stone-400"}>{statusLabels[log.status]}</div></div> },
        { title: "用户", key: "user", width: 130, ellipsis: true, render: (_, log) => log.userDisplayName ? <span title={`@${log.username || ""}`}>{log.userDisplayName}</span> : <span className="text-stone-400">—</span> },
        { title: "类型", dataIndex: "type", width: 76, render: (value: RequestLog["type"]) => value === "probe" ? <span className="text-stone-400">{typeLabels[value]}</span> : typeLabels[value] },
        { title: "模型 / 渠道", key: "model", width: 250, ellipsis: true, render: (_, log) => <div><div className="truncate" title={log.modelDisplayNameSnapshot || undefined}>{log.modelDisplayNameSnapshot || <span className="text-stone-400">—</span>}</div><div className="truncate text-xs text-stone-500" title={log.upstreamModel || undefined}>{[log.channelNameSnapshot, log.upstreamModel].filter(Boolean).join(" · ") || "—"}</div></div> },
        { title: "HTTP", dataIndex: "httpStatus", width: 70, render: (value: number | null, log) => value ? <span className={log.status === "failed" ? "text-red-500" : ""}>{value}</span> : <span className="text-stone-300 dark:text-stone-600">—</span> },
        { title: "费用", key: "cost", width: 90, render: (_, log) => log.billedAmount != null ? `¥${Number(log.billedAmount).toFixed(2)}` : <span className="text-stone-300 dark:text-stone-600">—</span> },
        { title: "耗时", key: "duration", width: 130, render: (_, log) => <div className="flex items-center gap-2">{log.durationMs != null && <span className={`h-4 w-[3px] rounded-full ${log.status === "failed" ? "bg-red-400" : "bg-emerald-500"}`} />}<span className={log.durationMs == null ? "text-stone-300 dark:text-stone-600" : ""}>{log.durationMs == null ? "—" : `${(log.durationMs / 1000).toFixed(1)}s`}</span></div> },
        {
            title: "详情",
            key: "detail",
            render: (_, log) => {
                const summary = [log.errorCategory, log.httpStatus ? `HTTP ${log.httpStatus}` : "", log.errorMessage].filter(Boolean).join(" · ");
                return summary ? (
                    <Tooltip title="点击复制详情"><div className="max-w-[420px] cursor-pointer truncate hover:text-stone-950 dark:hover:text-stone-100" onClick={() => copyText(logDetail(log), "请求详情已复制")}>{summary}</div></Tooltip>
                ) : <span className="text-stone-300 dark:text-stone-600">—</span>;
            },
        },
    ];

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Request observability</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">请求日志</h1><p className="mt-1 text-sm text-stone-500">记录每次上游模型调用，含失败重试与手动探测；默认保留 30 天。</p></div>
                <div className="flex gap-2">
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void logsQuery.refetch()}>刷新</Button>
                    <Button danger icon={<Trash2 className="size-4" />} loading={clearMutation.isPending} onClick={() => modal.confirm({ title: "清空全部请求日志？", content: "将删除所有历史日志，正在运行的记录不受影响。", okText: "清空", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => clearMutation.mutateAsync() })}>清空日志</Button>
                </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-3 rounded-xl border border-stone-200 bg-background p-4 dark:border-stone-800">
                <Segmented value={preset} options={[{ label: "今天", value: 1 }, { label: "近 7 天", value: 7 }, { label: "近 30 天", value: 30 }]} onChange={(value) => { const days = Number(value); setPreset(days); setPage(1); setFilters((current) => ({ ...current, range: [dayjs().subtract(days - 1, "day").startOf("day"), dayjs()] })); }} />
                <DatePicker.RangePicker value={filters.range} allowClear={false} showTime={{ format: "HH:mm" }} onChange={(range) => range && setFilter("range", range as [Dayjs, Dayjs])} />
                <Select allowClear placeholder="全部用户" className="min-w-36" value={filters.userId} onChange={(value) => setFilter("userId", value)} options={(usersQuery.data || []).map((user) => ({ value: user.id, label: user.displayName }))} />
                <Select allowClear placeholder="全部模型" className="min-w-40" value={filters.modelId} onChange={(value) => setFilter("modelId", value)} options={(modelsQuery.data || []).map((model) => ({ value: model.id, label: model.displayName }))} />
                <Select allowClear placeholder="全部渠道" className="min-w-36" value={filters.channelId} onChange={(value) => setFilter("channelId", value)} options={(channelsQuery.data || []).map((channel) => ({ value: channel.id, label: channel.name }))} />
                <Select allowClear placeholder="全部类型" className="min-w-28" value={filters.type} onChange={(value) => setFilter("type", value as RequestLog["type"])} options={Object.entries(typeLabels).map(([value, label]) => ({ value, label }))} />
                <Select allowClear placeholder="全部状态" className="min-w-28" value={filters.status} onChange={(value) => setFilter("status", value as RequestLog["status"])} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} />
            </div>
            <div className="mt-5 overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800">
                <Table<RequestLog>
                    rowKey="id"
                    size="small"
                    columns={columns}
                    dataSource={logsQuery.data?.logs || []}
                    loading={logsQuery.isLoading}
                    scroll={{ x: 1160 }}
                    pagination={{ current: page, pageSize, total: logsQuery.data?.total || 0, showSizeChanger: true, showQuickJumper: true, pageSizeOptions: [10, 20, 50, 100], onChange: (page, size) => { setPage(page); setPageSize(size); }, showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条` }}
                />
            </div>
        </div>
    );
}

function logDetail(log: RequestLog) {
    return [
        `时间：${dayjs(log.startedAt).format("YYYY-MM-DD HH:mm:ss")}`,
        `状态：${statusLabels[log.status]}`,
        `用户：${log.userDisplayName || "—"}${log.username ? ` (@${log.username})` : ""}`,
        `类型：${typeLabels[log.type]}`,
        `模型：${log.modelDisplayNameSnapshot || "—"}${log.modelNameSnapshot ? ` (${log.modelNameSnapshot})` : ""}`,
        `渠道：${log.channelNameSnapshot || "—"}`,
        `上游模型：${log.upstreamModel || "—"}`,
        `HTTP：${log.httpStatus ?? "—"}`,
        `耗时：${log.durationMs == null ? "—" : `${(log.durationMs / 1000).toFixed(1)}s`}`,
        `费用：${log.billedAmount != null ? `¥${Number(log.billedAmount).toFixed(2)}` : "—"}`,
        ...(log.errorMessage ? [`错误：[${log.errorCategory || "unknown"}] ${log.errorMessage}`] : []),
    ].join("\n");
}
