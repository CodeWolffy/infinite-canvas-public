import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag } from "antd";
import { Copy, Download, FileSpreadsheet, FileText, Plus, Ticket } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { saveAs } from "file-saver";

import { createInvitation, getInvitations, setInvitationDisabled, type Invitation } from "@/services/api/billing";
import { useCopyText } from "@/hooks/use-copy-text";
import ReferralRecords from "./components/referral-records";

type BatchResult = {
    secrets: string[];
    note: string;
    maxUses: number;
    expiresAt?: string;
};

export default function InvitationsPage() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
    const [page, setPage] = useState(1);
    const [form] = Form.useForm<{ note: string; maxUses: number; count: number; expiresAt?: Dayjs }>();
    const query = useQuery({ queryKey: ["admin-invitations", page], queryFn: () => getInvitations((page - 1) * 50) });
    const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-invitations"] });

    const create = useMutation({
        mutationFn: createInvitation,
        onSuccess: (data, variables) => {
            const secrets = data.codes && data.codes.length > 0 ? data.codes : (data.code ? [data.code] : []);
            setBatchResult({
                secrets,
                note: variables.note || "",
                maxUses: variables.maxUses,
                expiresAt: variables.expiresAt,
            });
            setOpen(false);
            void refresh();
        },
        onError: (error: Error) => message.error(error.message),
    });

    const toggle = useMutation({
        mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => setInvitationDisabled(id, disabled),
        onSuccess: () => void refresh(),
        onError: (error: Error) => message.error(error.message),
    });

    const copy = useCopyText();

    const copyAllSecrets = (secrets: string[]) => {
        copy(secrets.join("\n"), `已复制 ${secrets.length} 个邀请码到剪贴板`);
    };

    const exportTxt = (secrets: string[]) => {
        const text = secrets.join("\n");
        saveAs(new Blob([text], { type: "text/plain;charset=utf-8" }), `邀请码-${dayjs().format("YYYYMMDDHHmmss")}.txt`);
        message.success("已导出 TXT 文件");
    };

    const exportCsv = (result: BatchResult) => {
        const headers = ["序号", "邀请码", "可注册人数", "备注", "有效期"];
        const rows = result.secrets.map((code, index) => [
            String(index + 1),
            code,
            String(result.maxUses),
            result.note || "-",
            result.expiresAt ? dayjs(result.expiresAt).format("YYYY-MM-DD HH:mm") : "长期有效",
        ]);
        const lines = [
            headers.map((h) => `"${h}"`).join(","),
            ...rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")),
        ];
        saveAs(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), `邀请码-${dayjs().format("YYYYMMDDHHmmss")}.csv`);
        message.success("已导出 CSV 文件");
    };

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-stone-500 mb-1">
                        <Ticket className="size-4 text-amber-500" />
                        <span className="text-xs font-semibold uppercase tracking-wider">Invitations & Referrals</span>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">邀请注册</h1>
                    <p className="mt-1 text-sm text-stone-500">控制新成员加入，按用途设置名额和有效期，支持批量生成与导出。</p>
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => { form.resetFields(); setOpen(true); }}>创建邀请码</Button>
            </div>
            {query.error ? <Alert className="mb-5" type="error" title={query.error.message} /> : null}
            <Table<Invitation> rowKey="id" dataSource={query.data?.invitations || []} loading={query.isPending} scroll={{ x: 850 }} pagination={false} columns={[
                { title: "邀请码标识", dataIndex: "codeHint", render: (value: string) => <span className="font-mono">{value}</span> },
                { title: "备注", dataIndex: "note" },
                { title: "使用情况", key: "uses", render: (_, item) => `${item.usedCount} / ${item.maxUses}` },
                { title: "有效期", dataIndex: "expiresAt", render: (value: string | null) => value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "长期有效" },
                { title: "状态", key: "state", render: (_, item) => item.disabled ? <Tag>已停用</Tag> : item.usedCount >= item.maxUses ? <Tag>已用完</Tag> : item.expiresAt && dayjs(item.expiresAt).isBefore(dayjs()) ? <Tag>已过期</Tag> : <Tag color="success">可使用</Tag> },
                { title: "启用", key: "enabled", render: (_, item) => <Switch checked={!item.disabled} loading={toggle.isPending && toggle.variables?.id === item.id} onChange={(enabled) => toggle.mutate({ id: item.id, disabled: !enabled })} aria-label={`启用邀请码 ${item.codeHint}`} /> },
            ]} />
            <div className="mt-4 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button disabled={(query.data?.invitations.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>下一页</Button></div>
            <Modal title="创建邀请码" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
                <Form form={form} layout="vertical" initialValues={{ maxUses: 1, count: 1, note: "" }} onFinish={(values) => create.mutate({ note: values.note, maxUses: values.maxUses, count: values.count, expiresAt: values.expiresAt?.toISOString() })}>
                    <Form.Item name="note" label="备注"><Input placeholder="例如：第一批创作者" /></Form.Item>
                    <div className="grid grid-cols-2 gap-3">
                        <Form.Item name="maxUses" label="每张可注册人数" rules={[{ required: true, message: "请填写名额" }]}><InputNumber min={1} precision={0} className="!w-full" /></Form.Item>
                        <Form.Item name="count" label="生成数量" rules={[{ required: true, message: "请填写数量" }]} extra="单次最多 100 张"><InputNumber min={1} max={100} precision={0} className="!w-full" /></Form.Item>
                    </div>
                    <Form.Item name="expiresAt" label="有效期至"><DatePicker showTime className="w-full" placeholder="不填则长期有效" /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={create.isPending}>创建</Button></Space>
                </Form>
            </Modal>
            <Modal
                title={`成功创建 ${batchResult?.secrets.length || 0} 个邀请码`}
                open={Boolean(batchResult)}
                onCancel={() => setBatchResult(null)}
                footer={[
                    <Button key="close" onClick={() => setBatchResult(null)}>关闭</Button>,
                    <Button key="copy" icon={<Copy className="size-4" />} onClick={() => batchResult && copyAllSecrets(batchResult.secrets)}>复制全部</Button>,
                    <Button key="txt" icon={<FileText className="size-4" />} onClick={() => batchResult && exportTxt(batchResult.secrets)}>导出 TXT</Button>,
                    <Button key="csv" type="primary" icon={<FileSpreadsheet className="size-4" />} onClick={() => batchResult && exportCsv(batchResult)}>导出 CSV</Button>,
                ]}
                width={650}
                destroyOnHidden
            >
                {batchResult ? (
                    <div className="space-y-4 pt-2">
                        <div className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
                            完整邀请码仅在本次创建后展示，请及时复制或导出妥善保存。
                        </div>
                        <div className="grid max-h-[360px] grid-cols-1 sm:grid-cols-2 gap-2 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50/50 p-3 text-xs dark:border-stone-800 dark:bg-stone-900/40">
                            {batchResult.secrets.map((secret, idx) => (
                                <div key={idx} className="flex items-center justify-between rounded-lg border border-stone-200/80 bg-background px-3 py-2 shadow-2xs dark:border-stone-800">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="font-mono text-[10px] text-stone-400 shrink-0">#{String(idx + 1).padStart(2, "0")}</span>
                                        <span className="select-all font-mono font-medium text-stone-900 dark:text-stone-100 truncate">{secret}</span>
                                    </div>
                                    <Button
                                        type="text"
                                        size="small"
                                        className="shrink-0 text-stone-400 hover:text-stone-800 dark:hover:text-stone-200"
                                        icon={<Copy className="size-3" />}
                                        onClick={() => {
                                            copy(secret, "已复制单个邀请码");
                                        }}
                                        title="复制"
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </Modal>
            <ReferralRecords />
        </div>
    );
}
