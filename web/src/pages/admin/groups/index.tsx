import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { Edit3, Plus, Sliders, Trash2, Users } from "lucide-react";

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
    const policy = useMutation({
        mutationFn: (values: GroupPolicy & { restricted: boolean; storageQuotaMb: number }) =>
            saveGroupPolicy(policyGroup!.id, {
                modelIds: values.restricted ? values.modelIds || [] : null,
                storageQuotaBytes: Math.round(Number(values.storageQuotaMb || 0) * 1024 * 1024),
            }),
        onSuccess: () => {
            void refresh();
            setPolicyGroup(null);
            message.success("模型权限与存储配额已保存");
        },
        onError: (error: Error) => message.error(error.message),
    });
    const query = useQuery({ queryKey: ["admin", "user-groups"], queryFn: getUserGroups });
    const refresh = () => client.invalidateQueries({ queryKey: ["admin", "user-groups"] });
    const save = useMutation({
        mutationFn: (values: { name: string; discount: number }) =>
            editing
                ? updateUserGroup(editing.id, { name: values.name, discount: String(values.discount) })
                : createUserGroup({ name: values.name, discount: String(values.discount) }),
        onSuccess: () => {
            void refresh();
            setEditing(undefined);
            message.success(editing ? "分组已更新" : "分组已创建");
        },
        onError: (error: Error) => message.error(error.message),
    });
    const remove = useMutation({
        mutationFn: deleteUserGroup,
        onSuccess: () => {
            void refresh();
            message.success("分组已删除");
        },
        onError: (error: Error) => message.error(error.message),
    });

    const openPolicy = (group: UserGroup) => {
        setPolicyGroup(group);
        policyForm.setFieldsValue({
            restricted: group.modelIds != null,
            modelIds: group.modelIds || [],
            storageQuotaMb: Number(group.storageQuotaBytes || 0) / (1024 * 1024),
        });
    };

    const columns: TableColumnsType<UserGroup> = [
        {
            title: "分组名称",
            dataIndex: "name",
            width: 180,
            render: (name: string) => (
                <div className="flex items-center gap-2">
                    <span className="font-medium text-stone-950 dark:text-stone-100">{name}</span>
                    {name === "默认" ? (
                        <Tag bordered={false} className="!m-0 text-xs">默认</Tag>
                    ) : null}
                </div>
            ),
        },
        {
            title: "折扣",
            dataIndex: "discount",
            width: 130,
            render: (value: string) => {
                const num = Number(value);
                if (num === 1) return <Tag bordered={false}>原价</Tag>;
                if (num === 0) return <Tag bordered={false} color="purple">免费 (0x)</Tag>;
                return (
                    <Tag bordered={false} color={num < 1 ? "green" : "orange"}>
                        {num < 1 ? `${(num * 10).toFixed(1)} 折` : `×${value}`}
                    </Tag>
                );
            },
        },
        {
            title: "成员数",
            dataIndex: "memberCount",
            width: 100,
            render: (count: number) => (
                <span className="text-stone-600 dark:text-stone-300">
                    <span className="font-mono font-medium">{count}</span>
                    <span className="ml-1 text-xs text-stone-400">人</span>
                </span>
            ),
        },
        {
            title: "模型与存储",
            key: "policy",
            width: 280,
            render: (_, group) => (
                <div
                    className="inline-flex flex-wrap items-center gap-1.5 cursor-pointer rounded px-1.5 py-1 -mx-1.5 hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors"
                    onClick={() => openPolicy(group)}
                    title="点击配置模型权限与存储配额"
                >
                    {group.modelIds == null ? (
                        <Tag bordered={false} className="!m-0 text-stone-600 dark:text-stone-300">
                            不限模型
                        </Tag>
                    ) : (
                        <Tag bordered={false} color="blue" className="!m-0">
                            可用 {group.modelIds.length} 个模型
                        </Tag>
                    )}
                    {Number(group.storageQuotaBytes || 0) > 0 ? (
                        <Tag bordered={false} color="purple" className="!m-0 font-mono">
                            存储 {formatBytes(Number(group.storageQuotaBytes))}
                        </Tag>
                    ) : (
                        <Tag bordered={false} className="!m-0 text-stone-400 dark:text-stone-500">
                            未设存储配额
                        </Tag>
                    )}
                </div>
            ),
        },
        {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 170,
            render: (value: string) => (
                <span className="text-xs text-stone-500">
                    {dayjs(value).format("YYYY-MM-DD HH:mm")}
                </span>
            ),
        },
        {
            title: "操作",
            key: "actions",
            width: 200,
            fixed: "right",
            render: (_, group) => (
                <Space size={2}>
                    <Button
                        type="text"
                        size="small"
                        icon={<Sliders className="size-3.5" />}
                        onClick={() => openPolicy(group)}
                    >
                        权限与存储
                    </Button>
                    <Button
                        type="text"
                        size="small"
                        icon={<Edit3 className="size-3.5" />}
                        onClick={() => {
                            setEditing(group);
                            form.setFieldsValue({ name: group.name, discount: Number(group.discount) });
                        }}
                    >
                        编辑
                    </Button>
                    {group.memberCount === 0 && group.name !== "默认" ? (
                        <Popconfirm
                            title={`删除分组 ${group.name}？`}
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => remove.mutate(group.id)}
                        >
                            <Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />}>
                                删除
                            </Button>
                        </Popconfirm>
                    ) : null}
                </Space>
            ),
        },
    ];

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-stone-500 mb-1">
                        <Users className="size-4 text-indigo-500" />
                        <span className="text-xs font-semibold uppercase tracking-wider">User Groups & Policies</span>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">用户分组</h1>
                    <p className="mt-1 text-sm text-stone-500">配置分组折扣、模型权限与存储配额。余额永久有效，额外赠送通过兑换码发放。</p>
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); form.setFieldsValue({ discount: 1 }); }}>创建分组</Button>
            </div>
            {query.error ? <Alert className="mb-5" type="error" title={query.error.message} /> : null}
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800">
                <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                    <span className="text-xs text-stone-500">共 {query.data?.groups.length || 0} 个用户分组</span>
                </div>
                <Table<UserGroup>
                    rowKey="id"
                    columns={columns}
                    dataSource={query.data?.groups || []}
                    loading={query.isPending}
                    pagination={false}
                    scroll={{ x: 960 }}
                    locale={{
                        emptyText: (
                            <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={query.isError ? "加载失败" : "暂无用户分组"}
                            />
                        ),
                    }}
                />
            </div>
            <Modal title={`${policyGroup?.name || "分组"} · 模型权限与存储`} open={Boolean(policyGroup)} footer={null} onCancel={() => setPolicyGroup(null)} forceRender>
                <Form form={policyForm} layout="vertical" onFinish={(values) => policy.mutate(values)} className="pt-3">
                    <Form.Item name="restricted" label="限制可用模型" valuePropName="checked"><Switch /></Form.Item>
                    {restricted ? <Form.Item name="modelIds" label="允许使用的模型" extra="不选择任何模型表示该组暂不能生成。"><Select mode="multiple" loading={models.isPending} options={(models.data || []).map((model) => ({ value: model.id, label: model.displayName }))} /></Form.Item> : null}
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
        </div>
    );
}
