import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Plus, ShieldAlert } from "lucide-react";

import { deleteSensitiveWord, getSensitiveWords, saveSensitiveWord, type SensitiveWord } from "@/services/api/billing";
import { getSensitiveEvents } from "@/services/api/platform-operations";

export default function AdminSensitivePage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [open, setOpen] = useState(false);
    const [form] = Form.useForm<{ pattern: string; action: "block" | "review" }>();
    const query = useQuery({ queryKey: ["admin", "sensitive-words"], queryFn: getSensitiveWords });
    const events = useQuery({ queryKey: ["admin", "sensitive-events"], queryFn: getSensitiveEvents });
    const refresh = () => client.invalidateQueries({ queryKey: ["admin", "sensitive-words"] });
    const save = useMutation({ mutationFn: saveSensitiveWord, onSuccess: () => { void refresh(); setOpen(false); message.success("敏感词已保存"); }, onError: (error: Error) => message.error(error.message) });
    const remove = useMutation({ mutationFn: deleteSensitiveWord, onSuccess: () => { void refresh(); message.success("敏感词已删除"); }, onError: (error: Error) => message.error(error.message) });

    const columns: TableColumnsType<SensitiveWord> = [
        { title: "关键词", dataIndex: "pattern", render: (value: string) => <span className="font-mono">{value}</span> },
        { title: "处理方式", dataIndex: "action", width: 120, render: (value: SensitiveWord["action"]) => value === "block" ? <Tag color="red">直接拦截</Tag> : <Tag color="orange">仅记录</Tag> },
        { title: "添加时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
        { title: "操作", key: "actions", width: 90, render: (_, word) => <Popconfirm title={`删除敏感词 ${word.pattern}？`} onConfirm={() => remove.mutate(word.id)}><Button type="text" danger size="small">删除</Button></Popconfirm> },
    ];

    return <div className="w-full px-5 py-8 lg:px-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><ShieldAlert className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">敏感词</h1><p className="mt-2 text-sm text-muted-foreground">按子串匹配生成提示词与对话内容；「直接拦截」在提交时拒绝，「仅记录」暂不拦截。</p></div><Button type="primary" icon={<Plus className="size-4" />} onClick={() => { form.resetFields(); setOpen(true); }}>添加敏感词</Button></div>
        {query.error ? <Alert className="mb-5" type="error" title={query.error.message} /> : null}
        <Table<SensitiveWord> rowKey="id" columns={columns} dataSource={query.data?.words || []} loading={query.isPending} pagination={false} />
        <div className="mb-4 mt-9 flex items-center justify-between"><h2 className="text-lg font-medium">最近命中记录</h2><Button type="text" onClick={() => void events.refetch()}>刷新记录</Button></div>
        <p className="mb-4 text-sm text-muted-foreground">“仅记录”允许继续生成，保留命中规则和用户，不保存完整提示词。</p>
        {events.error ? <Alert type="error" title={events.error.message} /> : <Table rowKey="id" dataSource={events.data?.events || []} loading={events.isPending} pagination={false} columns={[{ title: "用户", dataIndex: "username" }, { title: "命中规则", render: (_, event) => event.detail.pattern }, { title: "处理", render: (_, event) => <Tag color={event.detail.action === "block" ? "red" : "default"}>{event.detail.action === "block" ? "已拦截" : "仅记录"}</Tag> }, { title: "时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() }]} />}
        <Modal title="添加敏感词" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
            <Form form={form} layout="vertical" initialValues={{ action: "block" }} onFinish={(values) => save.mutate(values)}>
                <Form.Item name="pattern" label="关键词" rules={[{ required: true, message: "请输入关键词" }]}><Input placeholder="按子串匹配，不区分大小写" /></Form.Item>
                <Form.Item name="action" label="处理方式"><Select options={[{ value: "block", label: "直接拦截" }, { value: "review", label: "仅记录" }]} /></Form.Item>
                <Space className="flex justify-end"><Button onClick={() => setOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={save.isPending}>保存</Button></Space>
            </Form>
        </Modal>
    </div>;
}
