import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Select, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Copy, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";

import { formatDuration } from "@/lib/image-utils";
import { getUserLogs, type UserRequestLog } from "@/services/api/user-center";

export default function UserLogsPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [logs, setLogs] = useState<UserRequestLog[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [typeFilter, setTypeFilter] = useState<"image" | "text" | "video" | "audio" | undefined>(undefined);
    const [statusFilter, setStatusFilter] = useState<"running" | "succeeded" | "failed" | undefined>(undefined);

    const loadLogs = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getUserLogs({
                type: typeFilter,
                status: statusFilter,
                limit: pageSize,
                offset: (page - 1) * pageSize,
            });
            setLogs(data.logs);
            setTotal(data.total);
        } catch {
            message.error("获取调用日志失败");
        } finally {
            setLoading(false);
        }
    }, [message, page, pageSize, statusFilter, typeFilter]);

    useEffect(() => {
        void loadLogs();
    }, [loadLogs]);

    const handleCopyError = (errorMessage: string) => {
        void navigator.clipboard.writeText(errorMessage);
        message.success(t("userCenter.errorCopied"));
    };

    const columns: ColumnsType<UserRequestLog> = [
        {
            title: t("userCenter.colTime"),
            dataIndex: "startedAt",
            key: "startedAt",
            width: 170,
            render: (value: string) => (
                <span className="font-mono text-xs text-stone-500">
                    {dayjs(value).format("YYYY-MM-DD HH:mm:ss")}
                </span>
            ),
        },
        {
            title: t("userCenter.colType"),
            dataIndex: "type",
            key: "type",
            width: 90,
            render: (value: string) => {
                const isImage = value === "image";
                return (
                    <Tag color={isImage ? "purple" : "cyan"}>
                        {value === "video" ? "视频" : value === "audio" ? "音频" : value === "probe" ? "探测" : isImage ? t("userCenter.typeImage") : t("userCenter.typeText")}
                    </Tag>
                );
            },
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
            width: 100,
            render: (value: string) => {
                if (value === "succeeded") return <Tag color="success">{t("userCenter.statusSucceeded")}</Tag>;
                if (value === "failed") return <Tag color="error">{t("userCenter.statusFailed")}</Tag>;
                return <Tag color="processing">{t("userCenter.statusRunning")}</Tag>;
            },
        },
        {
            title: t("userCenter.colDuration"),
            dataIndex: "durationMs",
            key: "durationMs",
            width: 100,
            render: (value: number | null) => (
                <span className="font-mono text-xs text-stone-500">
                    {value !== null ? formatDuration(value) : "-"}
                </span>
            ),
        },
        {
            title: t("userCenter.colError"),
            dataIndex: "errorMessage",
            key: "errorMessage",
            ellipsis: true,
            render: (value: string | null, record) => {
                if (!value && !record.errorCategory) return <span className="text-stone-400">-</span>;
                const errText = value || record.errorCategory || "";
                return (
                    <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-red-600 dark:text-red-400" title={errText}>
                            {errText}
                        </span>
                        <Tooltip title={t("userCenter.copyError")}>
                            <Button
                                size="small"
                                type="text"
                                icon={<Copy className="size-3" />}
                                onClick={() => handleCopyError(errText)}
                            />
                        </Tooltip>
                    </div>
                );
            },
        },
    ];

    return (
        <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="m-0 text-xl font-semibold text-stone-950 dark:text-stone-100">
                        {t("userCenter.logsTitle")}
                    </h2>
                    <p className="mt-1 text-sm text-stone-500">
                        {t("userCenter.logsDesc")}
                    </p>
                </div>
                <Button icon={<RefreshCw className="size-4" />} onClick={() => void loadLogs()} loading={loading}>
                    刷新
                </Button>
            </div>

            <Card className="border-stone-200 dark:border-stone-800" bodyStyle={{ padding: "1rem" }}>
                <div className="mb-4 flex flex-wrap items-center gap-3">
                    <Select
                        value={typeFilter}
                        onChange={(value) => {
                            setTypeFilter(value);
                            setPage(1);
                        }}
                        allowClear
                        placeholder={t("userCenter.filterAllType")}
                        className="w-32"
                        options={[
                            { value: "image", label: t("userCenter.typeImage") },
                            { value: "text", label: t("userCenter.typeText") },
                            { value: "video", label: "视频" },
                            { value: "audio", label: "音频" },
                        ]}
                    />
                    <Select
                        value={statusFilter}
                        onChange={(value) => {
                            setStatusFilter(value);
                            setPage(1);
                        }}
                        allowClear
                        placeholder={t("userCenter.filterAllStatus")}
                        className="w-32"
                        options={[
                            { value: "succeeded", label: t("userCenter.statusSucceeded") },
                            { value: "failed", label: t("userCenter.statusFailed") },
                            { value: "running", label: t("userCenter.statusRunning") },
                        ]}
                    />
                </div>

                <Table
                    rowKey="id"
                    columns={columns}
                    dataSource={logs}
                    loading={loading}
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
                />
            </Card>
        </div>
    );
}
