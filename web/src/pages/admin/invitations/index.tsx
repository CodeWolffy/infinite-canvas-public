import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from "antd";
import { Plus, Ticket } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";

import { createInvitation, getInvitations, setInvitationDisabled, type Invitation } from "@/services/api/billing";

export default function InvitationsPage() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [code, setCode] = useState("");
    const [page, setPage] = useState(1);
    const [form] = Form.useForm<{ note: string; maxUses: number; expiresAt?: Dayjs }>();
    const query = useQuery({ queryKey: ["admin-invitations", page], queryFn: () => getInvitations((page - 1) * 50) });
    const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-invitations"] });
    const create = useMutation({ mutationFn: createInvitation, onSuccess: (data) => { setCode(data.code); setOpen(false); void refresh(); }, onError: (error: Error) => message.error(error.message) });
    const toggle = useMutation({ mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => setInvitationDisabled(id, disabled), onSuccess: () => { void refresh(); }, onError: (error: Error) => message.error(error.message) });

    return <div className="w-full px-5 py-8 lg:px-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><Ticket className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">邀请注册</h1><p className="mt-2 text-sm text-muted-foreground">控制新成员加入，按用途设置名额和有效期。</p></div><Button type="primary" icon={<Plus className="size-4" />} onClick={() => { form.resetFields(); setOpen(true); }}>创建邀请码</Button></div>
        {query.error ? <Alert className="mb-5" type="error" title={query.error.message} /> : null}
        {code ? <Alert className="mb-5" type="success" closable onClose={() => setCode("")} title="邀请码已创建，请复制保存" description={<><Typography.Paragraph copyable className="!mb-1 mt-2 font-mono break-all">{code}</Typography.Paragraph><span>完整邀请码仅在本次创建后显示。</span></>} /> : null}
        <Table<Invitation> rowKey="id" dataSource={query.data?.invitations || []} loading={query.isPending} scroll={{ x: 850 }} pagination={false} columns={[
            { title: "邀请码", dataIndex: "codeHint", render: (value: string) => <span className="font-mono">{value}</span> },
            { title: "备注", dataIndex: "note" },
            { title: "使用情况", key: "uses", render: (_, item) => `${item.usedCount} / ${item.maxUses}` },
            { title: "有效期", dataIndex: "expiresAt", render: (value: string | null) => value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "长期有效" },
            { title: "状态", key: "state", render: (_, item) => item.disabled ? <Tag>已停用</Tag> : item.usedCount >= item.maxUses ? <Tag>已用完</Tag> : item.expiresAt && dayjs(item.expiresAt).isBefore(dayjs()) ? <Tag>已过期</Tag> : <Tag color="success">可使用</Tag> },
            { title: "启用", key: "enabled", render: (_, item) => <Switch checked={!item.disabled} loading={toggle.isPending && toggle.variables?.id === item.id} onChange={(enabled) => toggle.mutate({ id: item.id, disabled: !enabled })} aria-label={`启用邀请码 ${item.codeHint}`} /> },
        ]} />
        <div className="mt-4 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button disabled={(query.data?.invitations.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>下一页</Button></div>
        <Modal title="创建邀请码" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
            <Form form={form} layout="vertical" initialValues={{ maxUses: 1, note: "" }} onFinish={(values) => create.mutate({ note: values.note, maxUses: values.maxUses, expiresAt: values.expiresAt?.toISOString() })}>
                <Form.Item name="note" label="备注"><Input placeholder="例如：第一批创作者" /></Form.Item>
                <Form.Item name="maxUses" label="可注册人数" rules={[{ required: true, message: "请填写名额" }]}><InputNumber min={1} precision={0} className="!w-full" /></Form.Item>
                <Form.Item name="expiresAt" label="有效期至"><DatePicker showTime className="w-full" placeholder="不填则长期有效" /></Form.Item>
                <Space className="flex justify-end"><Button onClick={() => setOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={create.isPending}>创建</Button></Space>
            </Form>
        </Modal>
    </div>;
}
