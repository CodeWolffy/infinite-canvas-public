import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { Plus, Ticket } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";

import { createRedeemCode, getRedeemCodes, setRedeemCodeDisabled, type RedeemCode } from "@/services/api/billing";

export default function AdminRedeemPage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [open, setOpen] = useState(false);
    const [secret, setSecret] = useState("");
    const [page, setPage] = useState(1);
    const [form] = Form.useForm<{ note: string; amount: string; maxUses: number; expiresAt?: Dayjs }>();
    const query = useQuery({ queryKey: ["admin", "redeem-codes", page], queryFn: () => getRedeemCodes((page - 1) * 50) });
    const refresh = () => client.invalidateQueries({ queryKey: ["admin", "redeem-codes"] });
    const create = useMutation({ mutationFn: createRedeemCode, onSuccess: (data) => { setSecret(data.secret); setOpen(false); void refresh(); }, onError: (error: Error) => message.error(error.message) });
    const toggle = useMutation({ mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => setRedeemCodeDisabled(id, disabled), onSuccess: () => void refresh(), onError: (error: Error) => message.error(error.message) });

    const columns: TableColumnsType<RedeemCode> = [
        { title: "兑换码", dataIndex: "codeHint", render: (value: string) => <span className="font-mono">{value}</span> },
        { title: "面额", dataIndex: "amount", width: 110, render: (value: string) => `¥${value}` },
        { title: "备注", dataIndex: "note" },
        { title: "使用情况", key: "uses", width: 100, render: (_, item) => `${item.usedCount} / ${item.maxUses}` },
        { title: "有效期", dataIndex: "expiresAt", render: (value: string | null) => value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "长期有效" },
        { title: "状态", key: "state", render: (_, item) => item.disabled ? <Tag>已停用</Tag> : item.usedCount >= item.maxUses ? <Tag>已用完</Tag> : item.expiresAt && dayjs(item.expiresAt).isBefore(dayjs()) ? <Tag>已过期</Tag> : <Tag color="success">可兑换</Tag> },
        { title: "启用", key: "enabled", width: 80, render: (_, item) => <Switch checked={!item.disabled} loading={toggle.isPending && toggle.variables?.id === item.id} onChange={(enabled) => toggle.mutate({ id: item.id, disabled: !enabled })} aria-label={`启用兑换码 ${item.codeHint}`} /> },
    ];

    return <div className="w-full px-5 py-8 lg:px-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><Ticket className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">充值兑换码</h1><p className="mt-2 text-sm text-muted-foreground">线下发放额度：一个兑换码可被多个用户各兑换一次，到账金额相同。</p></div><Button type="primary" icon={<Plus className="size-4" />} onClick={() => { form.resetFields(); setOpen(true); }}>创建兑换码</Button></div>
        {query.error ? <Alert className="mb-5" type="error" title={query.error.message} /> : null}
        {secret ? <Alert className="mb-5" type="success" closable onClose={() => setSecret("")} title="兑换码已创建，请复制发放" description={<><Typography.Paragraph copyable className="!mb-1 mt-2 font-mono break-all">{secret}</Typography.Paragraph><span>完整兑换码仅在本次创建后显示。</span></>} /> : null}
        <Table<RedeemCode> rowKey="id" columns={columns} dataSource={query.data?.codes || []} loading={query.isPending} pagination={false} scroll={{ x: 900 }} />
        <div className="mt-4 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button disabled={(query.data?.codes.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>下一页</Button></div>
        <Modal title="创建兑换码" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
            <Form form={form} layout="vertical" initialValues={{ maxUses: 1, amount: "1" }} onFinish={(values) => create.mutate({ note: values.note, amount: String(values.amount), maxUses: values.maxUses, expiresAt: values.expiresAt?.toISOString() })}>
                <Form.Item name="note" label="备注"><Input placeholder="例如：活动奖励" /></Form.Item>
                <div className="grid grid-cols-2 gap-4">
                    <Form.Item name="amount" label="面额（元）" rules={[{ required: true, message: "请填写面额" }]}><InputNumber<string> stringMode min="0.000001" precision={6} className="!w-full" /></Form.Item>
                    <Form.Item name="maxUses" label="可兑换人数" rules={[{ required: true, message: "请填写人数" }]}><InputNumber min={1} precision={0} className="!w-full" /></Form.Item>
                </div>
                <Form.Item name="expiresAt" label="有效期至"><DatePicker showTime className="w-full" placeholder="不填则长期有效" /></Form.Item>
                <Space className="flex justify-end"><Button onClick={() => setOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={create.isPending}>创建</Button></Space>
            </Form>
        </Modal>
    </div>;
}
