import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, Card, DatePicker, Descriptions, Drawer, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { History, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import dayjs, { type Dayjs } from "dayjs";

import { useCopyText } from "@/hooks/use-copy-text";
import { useUserStore } from "@/stores/use-user-store";
import { formatDuration } from "@/lib/image-utils";
import { walletEntryLabels } from "@/services/api/billing";
import { getUserLogs, type UserLogTotals, type UserLogType, type UserRequestLog } from "@/services/api/user-center";

const typeColors: Record<string, string> = { image: "purple", text: "cyan", video: "orange", audio: "green", probe: "default", recharge: "green", checkin: "gold", referral: "cyan", grant: "purple", adjustment: "orange" };
const statusColors: Record<string, string> = { succeeded: "success", failed: "error", running: "processing" };
const fundTypes = new Set<UserLogType>(["recharge", "checkin", "referral", "grant", "adjustment"]);
const isFundLog = (record: UserRequestLog) => record.source === "wallet";
const signedAmount = (value: string | null | undefined) => { const text = String(value ?? "0"); return Number(text) > 0 ? `+${text}` : text; };
const fundAmount = (value: string | null | undefined) => { const text = String(value ?? "0"); return `${Number(text) >= 0 ? "+" : "-"}¥${text.replace(/^-/, "")}`; };

export default function UserLogsPage() {
    const { t } = useTranslation();
    const copy = useCopyText();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [typeFilter, setTypeFilter] = useState<UserLogType | undefined>(undefined);
    const [statusFilter, setStatusFilter] = useState<"running" | "succeeded" | "failed" | undefined>(undefined);
    const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
    const [detail, setDetail] = useState<UserRequestLog | null>(null);
    // 筛选与分页全部进 queryKey，切换时保留上一页数据，不再手写 loading 与竞态判断。
    const logsQuery = useQuery({
        queryKey: ["user-logs", sessionVersion, page, pageSize, typeFilter, statusFilter, range?.[0].toISOString(), range?.[1].toISOString()],
        queryFn: () => getUserLogs({ type: typeFilter, status: statusFilter, from: range?.[0].toISOString(), to: range?.[1].toISOString(), limit: pageSize, offset: (page - 1) * pageSize }),
        placeholderData: keepPreviousData,
    });
    const logs = logsQuery.data?.logs || [];
    const total = logsQuery.data?.total || 0;
    const totals: UserLogTotals | null = logsQuery.data?.totals ?? null;
    const loading = logsQuery.isPending || logsQuery.isFetching;

    const typeLabel = (value: string) => walletEntryLabels[value] ?? (value === "image" ? t("userCenter.typeImage") : value === "text" ? t("userCenter.typeText") : value === "video" ? "视频" : value === "audio" ? "音频" : t("userCenter.typeProbe"));
    const statusLabel = (value: string) => (value === "succeeded" ? t("userCenter.statusSucceeded") : value === "failed" ? t("userCenter.statusFailed") : t("userCenter.statusRunning"));

    const columns: ColumnsType<UserRequestLog> = [
        {
            title: t("userCenter.colTime"),
            dataIndex: "startedAt",
            key: "startedAt",
            width: 160,
            render: (value: string, record) => {
                const bar = isFundLog(record)
                    ? (Number(record.deltaBalance) < 0 ? "bg-red-500" : "bg-emerald-500")
                    : record.status === "failed" ? "bg-red-500" : record.status === "running" ? "bg-amber-400" : "bg-emerald-500";
                return (
                    <span className="flex items-center gap-2">
                        <span className={`h-3.5 w-0.5 shrink-0 rounded-full ${bar}`} />
                        <span className="font-mono text-xs text-stone-500">{dayjs(value).format("MM-DD HH:mm:ss")}</span>
                    </span>
                );
            },
        },
        {
            title: t("userCenter.colType"),
            dataIndex: "type",
            key: "type",
            width: 100,
            render: (value: string) => <Tag color={typeColors[value]}>{value === "recharge" ? "充值到账" : typeLabel(value)}</Tag>,
        },
        {
            title: t("userCenter.colModel"),
            dataIndex: "modelDisplayName",
            key: "modelDisplayName",
            ellipsis: true,
            render: (value: string | null) => (
                <span className="font-medium text-stone-900 dark:text-stone-100">
                    {value || "-"}
                </span>
            ),
        },
        {
            title: t("userCenter.colStatus"),
            dataIndex: "status",
            key: "status",
            width: 90,
            render: (value: string | null, record) => (isFundLog(record) || !value ? <span className="text-xs text-stone-400">-</span> : <Tag color={statusColors[value]}>{statusLabel(value)}</Tag>),
        },
        {
            title: t("userCenter.colDuration"),
            dataIndex: "durationMs",
            key: "durationMs",
            width: 90,
            render: (value: number | null) => (
                <span className="font-mono text-xs text-stone-500">
                    {value !== null ? formatDuration(value) : "-"}
                </span>
            ),
        },
        {
            title: t("userCenter.colTokens"),
            key: "tokens",
            width: 110,
            render: (_, record) => (
                <span className="font-mono text-xs text-stone-500">
                    {record.promptTokens !== null || record.completionTokens !== null
                        ? `${(record.promptTokens ?? 0).toLocaleString()} / ${(record.completionTokens ?? record.outputTokens ?? 0).toLocaleString()}`
                        : "-"}
                </span>
            ),
        },
        {
            title: t("userCenter.colCost"),
            dataIndex: "billedAmount",
            key: "billedAmount",
            width: 110,
            render: (value: string | null, record) => {
                if (isFundLog(record)) {
                    const positive = Number(record.deltaBalance) >= 0;
                    return <span className={`font-mono text-xs ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{fundAmount(record.deltaBalance)}</span>;
                }
                return <span className="font-mono text-xs text-stone-500">{value ? `¥${value}` : "-"}</span>;
            },
        },
        {
            title: "详情",
            key: "detail",
            ellipsis: true,
            render: (_, record) => {
                if (isFundLog(record)) return <span className="text-xs text-stone-500">{record.note || "-"}</span>;
                const errText = record.errorMessage || record.errorCategory;
                if (errText) return <span className="text-xs text-red-600 dark:text-red-400">{errText}</span>;
                return <span className="text-xs text-stone-400">-</span>;
            },
        },
    ];

    const succeeded = totals?.succeeded ?? 0;
    const failed = totals?.failed ?? 0;
    const running = totals?.running ?? 0;

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-stone-500 mb-1">
                        <History className="size-4 text-violet-500" />
                        <span className="text-xs font-semibold uppercase tracking-wider">Usage Logs</span>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">
                        {t("userCenter.logsTitle")}
                    </h1>
                    <p className="mt-1 text-sm text-stone-500">
                        {t("userCenter.logsDesc")}
                    </p>
                </div>
            </div>

            <Card className="border-stone-200 dark:border-stone-800" bodyStyle={{ padding: "1rem" }}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <DatePicker.RangePicker
                        showTime
                        value={range}
                        presets={[
                            { label: "今天", value: [dayjs().startOf("day"), dayjs()] as [Dayjs, Dayjs] },
                            { label: "近7天", value: [dayjs().subtract(6, "day").startOf("day"), dayjs()] as [Dayjs, Dayjs] },
                            { label: "本周", value: [dayjs().startOf("week"), dayjs()] as [Dayjs, Dayjs] },
                            { label: "近30天", value: [dayjs().subtract(29, "day").startOf("day"), dayjs()] as [Dayjs, Dayjs] },
                        ]}
                        onChange={(value) => {
                            setRange(value as [Dayjs, Dayjs] | null);
                            setPage(1);
                        }}
                    />
                    {range ? null : <span className="text-xs text-stone-500">默认仅统计最近 30 天，选择时间范围可查看更早记录</span>}
                    <Select
                        value={typeFilter}
                        onChange={(value) => {
                            setTypeFilter(value);
                            if (value && fundTypes.has(value)) setStatusFilter(undefined);
                            setPage(1);
                        }}
                        allowClear
                        placeholder={t("userCenter.filterAllType")}
                        className="w-36"
                        options={[
                            {
                                label: "调用",
                                options: [
                                    { value: "image", label: t("userCenter.typeImage") },
                                    { value: "text", label: t("userCenter.typeText") },
                                    { value: "video", label: "视频" },
                                    { value: "audio", label: "音频" },
                                    { value: "probe", label: "探测" },
                                ],
                            },
                            { label: "资金", options: [...fundTypes].map((kind) => ({ value: kind, label: walletEntryLabels[kind] })) },
                        ]}
                    />
                    <Select
                        disabled={Boolean(typeFilter && fundTypes.has(typeFilter))}
                        value={statusFilter}
                        onChange={(value) => {
                            setStatusFilter(value);
                            setPage(1);
                        }}
                        allowClear
                        placeholder={t("userCenter.filterAllStatus")}
                        className="w-28"
                        options={[
                            { value: "succeeded", label: t("userCenter.statusSucceeded") },
                            { value: "failed", label: t("userCenter.statusFailed") },
                            { value: "running", label: t("userCenter.statusRunning") },
                        ]}
                    />
                    <Button className="ml-auto" icon={<RefreshCw className="size-4" />} onClick={() => void logsQuery.refetch()} loading={loading}>
                        刷新
                    </Button>
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
                    <span>共 {total} 条</span>
                    {totals ? <>
                        <span><span className="text-emerald-600 dark:text-emerald-400">成功 {succeeded}</span></span>
                        <span><span className="text-red-600 dark:text-red-400">失败 {failed}</span></span>
                        <span><span className="text-amber-600 dark:text-amber-400">处理中 {running}</span></span>
                        <span>费用合计 <span className="font-mono">¥{totals.billedAmount}</span></span>
                    </> : null}
                    <span className="ml-auto">点击行查看详情</span>
                </div>

                <Table
                    rowKey="id"
                    columns={columns}
                    dataSource={logs}
                    loading={loading}
                    rowClassName="cursor-pointer"
                    onRow={(record) => ({ onClick: () => setDetail(record) })}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        onChange: (p, ps) => {
                            setPage(p);
                            setPageSize(ps);
                        },
                        showSizeChanger: true,
                        pageSizeOptions: ["10", "20", "50"],
                        showTotal: (tot) => `共 ${tot} 条记录`,
                    }}
                    size="small"
                    locale={{ emptyText: logsQuery.isError ? (logsQuery.error instanceof Error ? logsQuery.error.message : "获取调用日志失败") : undefined }}
                    scroll={{ x: 920 }}
                />
            </Card>

            <Drawer title={detail && isFundLog(detail) ? "资金详情" : "调用详情"} open={Boolean(detail)} onClose={() => setDetail(null)} destroyOnHidden>
                {detail && isFundLog(detail) ? <Descriptions column={1} items={[
                    { key: "time", label: "时间", children: <span className="font-mono text-xs">{dayjs(detail.startedAt).format("YYYY-MM-DD HH:mm:ss")}</span> },
                    { key: "kind", label: "类型", children: <Tag color={typeColors[detail.type]}>{typeLabel(detail.type)}</Tag> },
                    { key: "deltaBalance", label: "余额变动", children: <span className="font-mono">{signedAmount(detail.deltaBalance)}</span> },
                    { key: "deltaFrozen", label: "冻结变动", children: <span className="font-mono">{signedAmount(detail.deltaFrozen)}</span> },
                    { key: "balanceAfter", label: "变动后余额", children: <span className="font-mono">¥{detail.balanceAfter}</span> },
                    { key: "frozenAfter", label: "变动后冻结", children: <span className="font-mono">¥{detail.frozenAfter}</span> },
                    { key: "reference", label: "关联单号", children: detail.reference ? <Typography.Text copyable className="break-all font-mono text-xs">{detail.reference}</Typography.Text> : "—" },
                    { key: "note", label: "说明", children: detail.note || "—" },
                ]} /> : null}
                {detail && !isFundLog(detail) ? <Descriptions column={1} items={[
                    { key: "time", label: "请求时间", children: <span className="font-mono text-xs">{dayjs(detail.startedAt).format("YYYY-MM-DD HH:mm:ss")}</span> },
                    { key: "finished", label: "完成时间", children: detail.finishedAt ? <span className="font-mono text-xs">{dayjs(detail.finishedAt).format("YYYY-MM-DD HH:mm:ss")}</span> : "—" },
                    { key: "duration", label: "耗时", children: detail.durationMs !== null ? formatDuration(detail.durationMs) : "—" },
                    { key: "firstToken", label: "首 Token", children: detail.firstTokenMs !== null ? formatDuration(detail.firstTokenMs) : "—" },
                    { key: "type", label: "类型", children: <Tag color={typeColors[detail.type]}>{typeLabel(detail.type)}</Tag> },
                    { key: "model", label: "模型", children: detail.modelDisplayName || "—" },
                    { key: "status", label: "状态", children: detail.status ? <Tag color={statusColors[detail.status]}>{statusLabel(detail.status)}</Tag> : "—" },
                    { key: "http", label: "HTTP 状态", children: detail.httpStatus ?? "—" },
                    { key: "cost", label: "费用", children: detail.billedAmount ? <span className="font-mono">¥{detail.billedAmount}</span> : "—" },
                    { key: "tokens", label: "Tokens", children: detail.promptTokens !== null || detail.completionTokens !== null
                        ? <span className="font-mono text-xs">输入 {(detail.promptTokens ?? 0).toLocaleString()}{detail.cachedTokens ? `（缓存 ${detail.cachedTokens.toLocaleString()}）` : ""} · 输出 {(detail.completionTokens ?? detail.outputTokens ?? 0).toLocaleString()}</span>
                        : (detail.outputTokens !== null ? <span className="font-mono text-xs">输出 {detail.outputTokens.toLocaleString()}</span> : "—") },
                    { key: "task", label: "任务 ID", children: detail.taskId ? <Typography.Text copyable className="break-all font-mono text-xs">{detail.taskId}</Typography.Text> : "—" },
                    { key: "textReq", label: "文本请求 ID", children: detail.textRequestId ? <Typography.Text copyable className="break-all font-mono text-xs">{detail.textRequestId}</Typography.Text> : "—" },
                    { key: "errCategory", label: "错误分类", children: detail.errorCategory || "—" },
                    { key: "err", label: "错误信息", children: detail.errorMessage ? <span className="break-all text-red-600 dark:text-red-400">{detail.errorMessage} <Button type="text" size="small" onClick={() => copy(detail.errorMessage!, t("userCenter.errorCopied"))}>复制</Button></span> : "—" },
                ]} /> : null}
            </Drawer>
        </div>
    );
}
