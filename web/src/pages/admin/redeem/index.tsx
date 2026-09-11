import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { Copy, Download, FileSpreadsheet, FileText, Plus, Ticket } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { saveAs } from "file-saver";

import { createRedeemCode, getRedeemCodes, setRedeemCodeDisabled, type RedeemCode } from "@/services/api/billing";

type BatchResult = {
    secrets: string[];
    note: string;
    amount: string;
    maxUses: number;
    expiresAt?: string;
};

export default function AdminRedeemPage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [open, setOpen] = useState(false);
    const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
    const [page, setPage] = useState(1);
    const [form] = Form.useForm<{ note: string; amount: string; maxUses: number; count: number; expiresAt?: Dayjs }>();
    const query = useQuery({ queryKey: ["admin", "redeem-codes", page], queryFn: () => getRedeemCodes((page - 1) * 50) });
    const refresh = () => client.invalidateQueries({ queryKey: ["admin", "redeem-codes"] });

    const create = useMutation({
        mutationFn: createRedeemCode,
        onSuccess: (data, variables) => {
            const secrets = data.secrets && data.secrets.length > 0 ? data.secrets : (data.secret ? [data.secret] : []);
            setBatchResult({
                secrets,
                note: variables.note || "",
                amount: variables.amount,
                maxUses: variables.maxUses,
                expiresAt: variables.expiresAt,
            });
            setOpen(false);
            void refresh();
        },
        onError: (error: Error) => message.error(error.message),
    });

    const toggle = useMutation({
        mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => setRedeemCodeDisabled(id, disabled),
        onSuccess: () => void refresh(),
        onError: (error: Error) => message.error(error.message),
    });

    const codes = query.data?.codes || [];
    const activeCount = codes.filter((c) => !c.disabled && c.usedCount < c.maxUses && (!c.expiresAt || dayjs(c.expiresAt).isAfter(dayjs()))).length;
    const usedUpCount = codes.filter((c) => c.usedCount >= c.maxUses).length;
    const totalAmount = codes.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

    const copyAllSecrets = (secrets: string[]) => {
        void navigator.clipboard.writeText(secrets.join("\n")).then(() => {
            message.success(`已复制 ${secrets.length} 个兑换码到剪贴板`);
        });
    };

    const exportTxt = (secrets: string[]) => {
        const text = secrets.join("\n");
        saveAs(new Blob([text], { type: "text/plain;charset=utf-8" }), `兑换码-${dayjs().format("YYYYMMDDHHmmss")}.txt`);
        message.success("已导出 TXT 文件");
    };

    const exportCsv = (result: BatchResult) => {
        const headers = ["序号", "兑换码", "单张面额(元)", "可兑换人数", "备注", "有效期"];
        const rows = result.secrets.map((code, index) => [
            String(index + 1),
            code,
            result.amount,
            String(result.maxUses),
            result.note || "-",
            result.expiresAt ? dayjs(result.expiresAt).format("YYYY-MM-DD HH:mm") : "长期有效",
        ]);
        const lines = [
            headers.map((h) => `"${h}"`).join(","),
            ...rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")),
        ];
        saveAs(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), `兑换码-${dayjs().format("YYYYMMDDHHmmss")}.csv`);
        message.success("已导出 CSV 文件");
    };

    const columns: TableColumnsType<RedeemCode> = [
        {
            title: "兑换码标识",
            dataIndex: "codeHint",
            width: 220,
            render: (value: string) => (
                <div className="flex items-center gap-1.5 font-mono text-xs">
                    <span className="rounded bg-stone-100 px-2 py-0.5 font-medium text-stone-800 dark:bg-stone-800 dark:text-stone-200">
                        {value}
                    </span>
                    <Button
                        type="text"
                        size="small"
                        className="!h-6 !w-6 !p-0 text-stone-400 hover:text-stone-800 dark:hover:text-stone-200"
                        icon={<Copy className="size-3" />}
                        onClick={() => {
                            void navigator.clipboard.writeText(value);
                            message.success("已复制兑换码前缀");
                        }}
                        title="复制前缀"
                    />
                </div>
            ),
        },
        {
            title: "单张面额",
            dataIndex: "amount",
            width: 120,
            align: "right",
            sorter: (a, b) => Number(a.amount) - Number(b.amount),
            render: (value: string) => (
                <span className="font-mono font-semibold text-stone-900 dark:text-stone-100">
                    ¥{Number(value || 0).toFixed(2)}
                </span>
            ),
        },
        {
            title: "使用进度",
            key: "uses",
            width: 140,
            align: "center",
            render: (_, item) => {
                const percent = Math.min(100, Math.round((item.usedCount / item.maxUses) * 100));
                const isFull = item.usedCount >= item.maxUses;
                return (
                    <div className="flex flex-col items-center gap-1">
                        <span className="font-mono text-xs text-stone-600 dark:text-stone-300">
                            {item.usedCount} / {item.maxUses}
                        </span>
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
                            <div
                                className={`h-full ${isFull ? "bg-stone-400" : "bg-emerald-500"}`}
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                    </div>
                );
            },
        },
        {
            title: "状态",
            key: "state",
            width: 110,
            align: "center",
            render: (_, item) => {
                if (item.disabled) return <Tag>已停用</Tag>;
                if (item.usedCount >= item.maxUses) return <Tag>已用完</Tag>;
                if (item.expiresAt && dayjs(item.expiresAt).isBefore(dayjs())) return <Tag color="warning">已过期</Tag>;
                return <Tag color="success">可兑换</Tag>;
            },
        },
        {
            title: "有效期",
            dataIndex: "expiresAt",
            width: 170,
            render: (value: string | null) =>
                value ? (
                    <span className="font-mono text-xs text-stone-600 dark:text-stone-300">
                        {dayjs(value).format("YYYY-MM-DD HH:mm")}
                    </span>
                ) : (
                    <Tag bordered={false} className="text-xs text-stone-400">长期有效</Tag>
                ),
        },
        {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 160,
            render: (value: string) => (
                <span className="font-mono text-xs text-stone-400">
                    {value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}
                </span>
            ),
        },
        {
            title: "备注说明",
            dataIndex: "note",
            minWidth: 200,
            ellipsis: true,
            render: (value: string) => value || <span className="text-stone-300 dark:text-stone-600">-</span>,
        },
        {
            title: "启用",
            key: "enabled",
            width: 90,
            align: "center",
            render: (_, item) => (
                <Switch
                    size="small"
                    checked={!item.disabled}
                    loading={toggle.isPending && toggle.variables?.id === item.id}
                    onChange={(enabled) => toggle.mutate({ id: item.id, disabled: !enabled })}
                    aria-label={`启用兑换码 ${item.codeHint}`}
                />
            ),
        },
    ];

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
            {/* 页面头部 */}
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-stone-500 mb-1">
                        <Ticket className="size-4 text-amber-500" />
                        <span className="text-xs font-semibold uppercase tracking-wider">Vouchers & Redemption</span>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">充值兑换码</h1>
                    <p className="mt-1 text-sm text-stone-500">
                        线下额度发放与活动礼品：支持批量生成多张兑换码，并直接导出 TXT 与 CSV 表格。
                    </p>
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => { form.resetFields(); setOpen(true); }}>
                    创建兑换码
                </Button>
            </div>

            {/* 快捷摘要指标卡 */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-stone-200 bg-background p-3.5 shadow-sm dark:border-stone-800">
                    <div className="text-xs text-stone-500">兑换码总数</div>
                    <div className="mt-1.5 font-mono text-xl font-bold text-stone-950 dark:text-stone-100">{codes.length}</div>
                </div>
                <div className="rounded-xl border border-stone-200 bg-background p-3.5 shadow-sm dark:border-stone-800">
                    <div className="text-xs text-stone-500">当前可兑换</div>
                    <div className="mt-1.5 font-mono text-xl font-bold text-emerald-600 dark:text-emerald-400">{activeCount}</div>
                </div>
                <div className="rounded-xl border border-stone-200 bg-background p-3.5 shadow-sm dark:border-stone-800">
                    <div className="text-xs text-stone-500">已用完 / 已停用</div>
                    <div className="mt-1.5 font-mono text-xl font-bold text-stone-600 dark:text-stone-400">{usedUpCount}</div>
                </div>
                <div className="rounded-xl border border-stone-200 bg-background p-3.5 shadow-sm dark:border-stone-800">
                    <div className="text-xs text-stone-500">本页面额总计</div>
                    <div className="mt-1.5 font-mono text-xl font-bold text-stone-950 dark:text-stone-100">¥{totalAmount.toFixed(2)}</div>
                </div>
            </div>

            {query.error ? <Alert type="error" title={query.error.message} /> : null}

            {/* 数据表格卡片 */}
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-background shadow-sm dark:border-stone-800">
                <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3.5 dark:border-stone-800">
                    <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">兑换码列表</div>
                    <div className="flex items-center gap-2">
                        <Button size="small" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                            上一页
                        </Button>
                        <span className="font-mono text-xs text-stone-500">第 {page} 页</span>
                        <Button size="small" disabled={codes.length < 50} onClick={() => setPage((p) => p + 1)}>
                            下一页
                        </Button>
                    </div>
                </div>

                <Table<RedeemCode>
                    rowKey="id"
                    columns={columns}
                    dataSource={codes}
                    loading={query.isPending}
                    pagination={false}
                    scroll={{ x: 1150 }}
                />
            </div>

            {/* 创建兑换码弹窗 */}
            <Modal title="创建兑换码" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
                <Form
                    form={form}
                    layout="vertical"
                    initialValues={{ count: 1, maxUses: 1, amount: "1" }}
                    onFinish={(values) => create.mutate({
                        note: values.note,
                        amount: String(values.amount),
                        maxUses: values.maxUses,
                        count: values.count,
                        expiresAt: values.expiresAt?.toISOString(),
                    })}
                >
                    <Form.Item name="note" label="备注">
                        <Input placeholder="例如：社区 9 月福利活动" />
                    </Form.Item>
                    <div className="grid grid-cols-3 gap-3">
                        <Form.Item name="amount" label="面额（元）" rules={[{ required: true, message: "请填写面额" }]}>
                            <InputNumber<string> stringMode min="0.000001" precision={6} className="!w-full" />
                        </Form.Item>
                        <Form.Item name="maxUses" label="可兑换人数" rules={[{ required: true, message: "请填写人数" }]}>
                            <InputNumber min={1} precision={0} className="!w-full" />
                        </Form.Item>
                        <Form.Item name="count" label="生成数量" rules={[{ required: true, message: "请填写数量" }]}>
                            <InputNumber min={1} max={100} precision={0} className="!w-full" placeholder="1~100" />
                        </Form.Item>
                    </div>
                    <Form.Item name="expiresAt" label="有效期至">
                        <DatePicker showTime className="w-full" placeholder="不填则长期有效" />
                    </Form.Item>
                    <Space className="flex justify-end">
                        <Button onClick={() => setOpen(false)}>取消</Button>
                        <Button type="primary" htmlType="submit" loading={create.isPending}>
                            立即生成
                        </Button>
                    </Space>
                </Form>
            </Modal>

            {/* 批量兑换码结果弹窗 */}
            <Modal
                title={`兑换码已生成 (共 ${batchResult?.secrets.length || 0} 张)`}
                open={Boolean(batchResult)}
                onCancel={() => setBatchResult(null)}
                width={720}
                footer={[
                    <Button key="close" onClick={() => setBatchResult(null)}>关闭</Button>,
                    <Button key="copy" icon={<Copy className="size-3.5" />} onClick={() => batchResult && copyAllSecrets(batchResult.secrets)}>
                        复制全部
                    </Button>,
                    <Button key="txt" icon={<FileText className="size-3.5" />} onClick={() => batchResult && exportTxt(batchResult.secrets)}>
                        导出 TXT
                    </Button>,
                    <Button key="csv" type="primary" icon={<FileSpreadsheet className="size-3.5" />} onClick={() => batchResult && exportCsv(batchResult)}>
                        导出 CSV
                    </Button>,
                ]}
            >
                {batchResult ? (
                    <div className="space-y-4 py-2">
                        <Alert
                            type="warning"
                            showIcon
                            message="完整兑换码仅在本次生成后显示一次，请务必及时复制或导出保存！"
                        />
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 rounded-xl border border-stone-200/80 bg-stone-50/50 p-3 text-xs dark:border-stone-800 dark:bg-stone-900/30">
                            <div>
                                <span className="text-stone-400">单张面额</span>
                                <div className="mt-0.5 font-mono font-semibold text-stone-900 dark:text-stone-100">¥{batchResult.amount}</div>
                            </div>
                            <div>
                                <span className="text-stone-400">总计面额</span>
                                <div className="mt-0.5 font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                                    ¥{(Number(batchResult.amount) * batchResult.secrets.length).toFixed(2)}
                                </div>
                            </div>
                            <div>
                                <span className="text-stone-400">每张人数</span>
                                <div className="mt-0.5 font-mono font-semibold text-stone-900 dark:text-stone-100">{batchResult.maxUses} 人</div>
                            </div>
                            <div>
                                <span className="text-stone-400">有效期</span>
                                <div className="mt-0.5 text-stone-700 dark:text-stone-300">
                                    {batchResult.expiresAt ? dayjs(batchResult.expiresAt).format("YYYY-MM-DD") : "长期有效"}
                                </div>
                            </div>
                        </div>
                        {batchResult.note ? (
                            <div className="text-xs text-stone-500">
                                备注: <span className="text-stone-800 dark:text-stone-200">{batchResult.note}</span>
                            </div>
                        ) : null}
                        <div className="grid max-h-[380px] grid-cols-1 sm:grid-cols-2 gap-2 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50/50 p-3 text-xs dark:border-stone-800 dark:bg-stone-900/40">
                            {batchResult.secrets.map((code, idx) => (
                                <div
                                    key={idx}
                                    className="flex items-center justify-between rounded-lg border border-stone-200/80 bg-background px-3 py-2 shadow-2xs dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700 transition-colors"
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="font-mono text-[10px] text-stone-400 shrink-0">#{String(idx + 1).padStart(2, "0")}</span>
                                        <span className="select-all font-mono font-medium text-stone-900 dark:text-stone-100 truncate">{code}</span>
                                    </div>
                                    <Button
                                        type="text"
                                        size="small"
                                        className="shrink-0 text-stone-400 hover:text-stone-800 dark:hover:text-stone-200"
                                        icon={<Copy className="size-3" />}
                                        onClick={() => {
                                            void navigator.clipboard.writeText(code);
                                            message.success("已复制单个兑换码");
                                        }}
                                        title="复制"
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
