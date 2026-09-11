import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Edit3, Plus, Users } from "lucide-react";

import { formatBytes } from "@/lib/image-utils";
import { createUserGroup, deleteUserGroup, getUserGroups, updateUserGroup, type UserGroup } from "@/services/api/billing";
import { getAdminModels } from "@/services/api/admin-platform";
import { saveGroupPolicy, type GroupPolicy } from "@/services/api/platform-operations";

export default function AdminGroupsPage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [editing, setEditing] = useState<UserGroup | null | undefined>(undefined);
    const [form] = Form.useForm<{ name: string; discount: number }>();
    const [policyGroup, setPolicyGroup] = useState<UserGroup | null>(null);
    const [policyForm] = Form.useForm<GroupPolicy & { restricted: boolean; storageQuotaMb: number }>();
    const restricted = Form.useWatch("restricted", policyForm);
    const models = useQuery({ queryKey: ["admin", "models"], queryFn: getAdminModels, enabled: Boolean(policyGroup) });
    const policy = useMutation({ mutationFn: (values: GroupPolicy & { restricted: boolean; storageQuotaMb: number }) => saveGroupPolicy(policyGroup!.id, { modelIds: values.restricted ? values.modelIds || [] : null, grantAmount: String(values.grantAmount || "0"), grantPeriod: values.grantPeriod, spendLimit: String(values.spendLimit || "0"), spendPeriod: values.spendPeriod, storageQuotaBytes: Math.round(Number(values.storageQuotaMb || 0) * 1024 * 1024) }), onSuccess: () => { void refresh(); setPolicyGroup(null); message.success("模型权限、额度、消费上限与存储配额已保存"); }, onError: (error: Error) => message.error(error.message) });
    const query = useQuery({ queryKey: ["admin", "user-groups"], queryFn: getUserGroups });
    const refresh = () => client.invalidateQueries({ queryKey: ["admin", "user-groups"] });
    const save = useMutation({ mutationFn: (values: { name: string; discount: number }) => editing ? updateUserGroup(editing.id, { name: values.name, discount: String(values.discount) }) : createUserGroup({ name: values.name, discount: String(values.discount) }), onSuccess: () => { void refresh(); setEditing(undefined); message.success(editing ? "分组已更新" : "分组已创建"); }, onError: (error: Error) => message.error(error.message) });
    const remove = useMutation({ mutationFn: deleteUserGroup, onSuccess: () => { void refresh(); message.success("分组已删除"); }, onError: (error: Error) => message.error(error.message) });

    const columns: TableColumnsType<UserGroup> = [
        { title: "分组名称", dataIndex: "name" },
        { title: "折扣", dataIndex: "discount", width: 140, render: (value: string) => Number(value) === 1 ? <Tag>原价</Tag> : <Tag color={Number(value) < 1 ? "green" : "orange"}>{Number(value) < 1 ? `${(Number(value) * 10).toFixed(1)} 折` : `×${value}`}</Tag> },
        { title: "成员数", dataIndex: "memberCount", width: 100 },
        { title: "模型与额度", key: "policy", render: (_, group) => <div className="space-y-1"><div className="text-sm">{group.modelIds == null ? "不限模型" : `可用 ${group.modelIds.length} 个模型`}</div><div className="text-xs text-muted-foreground">{Number(group.spendLimit || 0) > 0 ? `消费上限 ¥${group.spendLimit}` : "未设消费上限"} · {Number(group.storageQuotaBytes || 0) > 0 ? `存储 ${formatBytes(Number(group.storageQuotaBytes))}` : "未设存储配额"}</div><Button type="link" size="small" onClick={() => { setPolicyGroup(group); policyForm.setFieldsValue({ restricted: group.modelIds != null, modelIds: group.modelIds || [], grantAmount: group.grantAmount || "0", grantPeriod: group.grantPeriod || "month", spendLimit: group.spendLimit || "0", spendPeriod: group.spendPeriod || "month", storageQuotaMb: Number(group.storageQuotaBytes || 0) / (1024 * 1024) }); }}>权限、额度与上限</Button></div> },
        { title: "创建时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
        { title: "操作", key: "actions", width: 140, render: (_, group) => <Space><Button type="text" size="small" icon={<Edit3 className="size-3.5" />} onClick={() => { setEditing(group); form.setFieldsValue({ name: group.name, discount: Number(group.discount) }); }}>编辑</Button>{group.memberCount === 0 && group.name !== "默认" ? <Popconfirm title={`删除分组 ${group.name}？`} onConfirm={() => remove.mutate(group.id)}><Button type="text" danger size="small">删除</Button></Popconfirm> : null}</Space> },
    ];

    return <div className="w-full px-5 py-8 lg:px-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><Users className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">用户分组</h1><p className="mt-2 text-sm text-muted-foreground">给账号分配分组后应用该组折扣、模型权限、公益额度、消费上限与存储配额；未分组用户按原价、不限模型且不设上限。</p></div><Button type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); form.setFieldsValue({ discount: 1 }); }}>创建分组</Button></div>
        {query.error ? <Alert className="mb-5" type="error" title={query.error.message} /> : null}
        <Table<UserGroup> rowKey="id" columns={columns} dataSource={query.data?.groups || []} loading={query.isPending} pagination={false} />
        <Modal title={`${policyGroup?.name || "分组"} · 模型、额度与上限`} open={Boolean(policyGroup)} footer={null} onCancel={() => setPolicyGroup(null)} forceRender>
            <Form form={policyForm} layout="vertical" onFinish={(values) => policy.mutate(values)} className="pt-3">
                <Form.Item name="restricted" label="限制可用模型" valuePropName="checked"><Switch /></Form.Item>
                {restricted ? <Form.Item name="modelIds" label="允许使用的模型" extra="不选择任何模型表示该组暂不能生成。"><Select mode="multiple" loading={models.isPending} options={(models.data || []).map((model) => ({ value: model.id, label: model.displayName }))} /></Form.Item> : null}
                <Form.Item name="grantAmount" label="每用户每周期公益额度（元）" extra="0 表示关闭。用户每周期领取一次；漏领不补发，已领取余额保留。"><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item>
                <Form.Item name="grantPeriod" label="领取周期（北京时间）"><Select options={[{ value: "day", label: "每天" }, { value: "week", label: "每周（周一开始）" }, { value: "month", label: "每月" }]} /></Form.Item>
                <Form.Item name="spendLimit" label="每用户每周期消费上限（元）" extra="0 表示关闭。统计实付加当前冻结额，达到上限后拒绝新的生成冻结。"><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item>
                <Form.Item name="spendPeriod" label="消费上限周期（北京时间）"><Select options={[{ value: "day", label: "每天" }, { value: "week", label: "每周（周一开始）" }, { value: "month", label: "每月" }]} /></Form.Item>
                <Form.Item name="storageQuotaMb" label="每用户存储配额（MB）" extra="0 表示关闭。统计该用户已落盘文件，达到上限后拒绝新的上传和生成结果保存。"><InputNumber min={0} precision={0} className="!w-full" /></Form.Item>
                <Button type="primary" htmlType="submit" block loading={policy.isPending}>保存规则</Button>
            </Form>
        </Modal>
        <Modal title={editing ? "编辑分组" : "创建分组"} open={editing !== undefined} footer={null} onCancel={() => setEditing(undefined)} destroyOnHidden>
            <Form form={form} layout="vertical" className="pt-3" onFinish={(values) => save.mutate(values)}>
                <Form.Item name="name" label="分组名称" rules={[{ required: true, message: "请输入分组名称" }]}><Input placeholder="例如：老用户 8 折" /></Form.Item>
                <Form.Item name="discount" label="价格系数" extra="1 为原价，0.8 表示 8 折，0 为免费；仅对生成与对话计费生效。" rules={[{ required: true }]}><InputNumber min={0} max={10} step={0.1} precision={4} className="w-full" /></Form.Item>
                <Space className="flex justify-end"><Button onClick={() => setEditing(undefined)}>取消</Button><Button type="primary" htmlType="submit" loading={save.isPending}>保存</Button></Space>
            </Form>
        </Modal>
    </div>;
}
