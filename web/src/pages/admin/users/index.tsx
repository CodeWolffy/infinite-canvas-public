import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Input, Modal, Select, Space, Switch, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { Copy, KeyRound, Plus, Search, UserRoundCog, UserRoundPlus } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { createAdminUser, getAdminUsers, resetAdminUserPassword, updateAdminUserRole, updateAdminUserStatus } from "@/services/api/admin-users";
import { getUserGroups, setUserGroup } from "@/services/api/billing";
import type { AuthUser, UserRole } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

type CreateValues = { username: string; displayName: string; temporaryPassword: string; role: UserRole };
type Credential = { username: string; displayName: string; temporaryPassword: string };

export default function AdminUsersPage() {
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const queryClient = useQueryClient();
    const currentUser = useUserStore((state) => state.user);
    const [keyword, setKeyword] = useState("");
    const [roleFilter, setRoleFilter] = useState<UserRole | undefined>();
    const [statusFilter, setStatusFilter] = useState<AuthUser["status"] | undefined>();
    const [createOpen, setCreateOpen] = useState(false);
    const [resettingUser, setResettingUser] = useState<AuthUser | null>(null);
    const [roleUser, setRoleUser] = useState<AuthUser | null>(null);
    const [roleValue, setRoleValue] = useState<UserRole>("user");
    const [groupUser, setGroupUser] = useState<AuthUser | null>(null);
    const [groupValue, setGroupValue] = useState<string | undefined>(undefined);
    const [credential, setCredential] = useState<Credential | null>(null);
    const [createForm] = Form.useForm<CreateValues>();
    const [resetForm] = Form.useForm<{ temporaryPassword: string }>();
    const usersQuery = useQuery({ queryKey: ["admin", "users"], queryFn: getAdminUsers });
    const groupsQuery = useQuery({ queryKey: ["admin", "user-groups"], queryFn: getUserGroups });

    const updateUserCache = (user: AuthUser) => queryClient.setQueryData<AuthUser[]>(["admin", "users"], (users = []) => users.map((item) => (item.id === user.id ? user : item)));
    const createMutation = useMutation({ mutationFn: createAdminUser, onSuccess: (user, variables) => { queryClient.setQueryData<AuthUser[]>(["admin", "users"], (users = []) => [user, ...users]); setCreateOpen(false); createForm.resetFields(); setCredential({ username: user.username, displayName: user.displayName, temporaryPassword: variables.temporaryPassword }); }, onError: showError(message.error) });
    const statusMutation = useMutation({ mutationFn: ({ id, status }: { id: string; status: "active" | "disabled" }) => updateAdminUserStatus(id, status), onSuccess: (user) => { updateUserCache(user); message.success(user.status === "active" ? "账号已启用" : "账号已禁用"); }, onError: showError(message.error) });
    const roleMutation = useMutation({ mutationFn: ({ id, role }: { id: string; role: UserRole }) => updateAdminUserRole(id, role), onSuccess: (user) => { updateUserCache(user); setRoleUser(null); message.success(user.role === "admin" ? "已设为管理员" : "已设为普通用户"); }, onError: showError(message.error) });
    const groupMutation = useMutation({ mutationFn: ({ id, groupId }: { id: string; groupId: string | null }) => setUserGroup(id, groupId), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["admin", "users"] }); setGroupUser(null); message.success("分组已调整"); }, onError: showError(message.error) });
    const resetMutation = useMutation({ mutationFn: ({ id, temporaryPassword }: { id: string; temporaryPassword: string }) => resetAdminUserPassword(id, temporaryPassword), onSuccess: (user, variables) => { updateUserCache(user); setResettingUser(null); resetForm.resetFields(); setCredential({ username: user.username, displayName: user.displayName, temporaryPassword: variables.temporaryPassword }); }, onError: showError(message.error) });

    const users = useMemo(() => {
        const normalized = keyword.trim().toLowerCase();
        return (usersQuery.data || []).filter((user) => {
            if (roleFilter && user.role !== roleFilter) return false;
            if (statusFilter && user.status !== statusFilter) return false;
            if (!normalized) return true;
            return `${user.displayName} ${user.username}`.toLowerCase().includes(normalized);
        });
    }, [keyword, usersQuery.data, roleFilter, statusFilter]);

    const changeStatus = (user: AuthUser, active: boolean) => {
        const status = active ? "active" : "disabled";
        if (status === "disabled") {
            modal.confirm({ title: `禁用 ${user.displayName}？`, content: "禁用后该用户的全部现有会话会立即失效。", okText: "确认禁用", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => statusMutation.mutateAsync({ id: user.id, status }) });
            return;
        }
        statusMutation.mutate({ id: user.id, status });
    };

    const columns: TableColumnsType<AuthUser> = [
        { title: "用户", key: "user", fixed: "left", width: 210, render: (_, user) => <div className="min-w-0"><div className="truncate font-medium text-stone-950 dark:text-stone-100">{user.displayName}</div><div className="truncate text-xs text-stone-500">@{user.username}</div></div> },
        { title: "角色", dataIndex: "role", width: 100, render: (role: UserRole) => <Tag color={role === "admin" ? "gold" : "default"}>{role === "admin" ? "管理员" : "普通用户"}</Tag> },
        { title: "分组", dataIndex: "groupName", width: 110, render: (value: string | null, user) => <Button type="text" size="small" className="!px-1.5" onClick={() => { setGroupUser(user); setGroupValue(user.groupId || undefined); }}>{value || "未分组"}</Button> },
        { title: "首次改密", dataIndex: "mustChangePassword", width: 110, render: (required: boolean) => required ? <Tag color="orange">待修改</Tag> : <span className="text-stone-500">已完成</span> },
        { title: "最近登录", dataIndex: "lastLoginAt", width: 170, render: (value: string | null) => <span className="text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "尚未登录"}</span> },
        { title: "创建时间", dataIndex: "createdAt", width: 170, render: (value: string) => <span className="text-stone-500">{dayjs(value).format("YYYY-MM-DD HH:mm")}</span> },
        { title: "启用", dataIndex: "status", width: 90, render: (status: AuthUser["status"], user) => <Switch size="small" checked={status === "active"} disabled={user.id === currentUser?.id || statusMutation.isPending} onChange={(checked) => changeStatus(user, checked)} /> },
        { title: "操作", key: "actions", fixed: "right", width: 185, render: (_, user) => <Space size={0}><Button type="text" size="small" disabled={user.id === currentUser?.id} icon={<KeyRound className="size-3.5" />} onClick={() => setResettingUser(user)}>重置密码</Button><Button type="text" size="small" disabled={user.id === currentUser?.id} icon={<UserRoundCog className="size-3.5" />} onClick={() => { setRoleUser(user); setRoleValue(user.role); }}>改角色</Button></Space> },
    ];

    return (
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Access control</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">用户管理</h1><p className="mt-1 text-sm text-stone-500">创建内部账号，控制账号状态和首次改密流程。</p></div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>创建用户</Button>
            </div>
            <div className="mt-7 overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 p-4 dark:border-stone-800">
                    <div className="flex flex-wrap items-center gap-2">
                        <Input allowClear prefix={<Search className="size-4 text-stone-400" />} placeholder="搜索姓名或用户名" value={keyword} onChange={(event) => setKeyword(event.target.value)} className="max-w-xs" />
                        <Select allowClear placeholder="全部角色" value={roleFilter} onChange={setRoleFilter} className="w-32" options={[{ value: "admin", label: "管理员" }, { value: "user", label: "普通用户" }]} />
                        <Select allowClear placeholder="全部状态" value={statusFilter} onChange={setStatusFilter} className="w-32" options={[{ value: "active", label: "已启用" }, { value: "disabled", label: "已禁用" }]} />
                    </div>
                    <span className="text-xs text-stone-500">共 {usersQuery.data?.length || 0} 个账号</span>
                </div>
                <Table<AuthUser> rowKey="id" columns={columns} dataSource={users} loading={usersQuery.isLoading} pagination={false} scroll={{ x: 980 }} locale={{ emptyText: usersQuery.isError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={usersQuery.error instanceof Error ? usersQuery.error.message : "用户加载失败"} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无用户" /> }} />
            </div>

            <Modal title="创建用户" open={createOpen} footer={null} onCancel={() => setCreateOpen(false)} destroyOnHidden>
                <Form<CreateValues> form={createForm} layout="vertical" requiredMark={false} initialValues={{ role: "user" }} className="pt-3" onFinish={(values) => createMutation.mutate(values)}>
                    <Form.Item name="username" label="用户名" extra="3–64 位，仅支持字母、数字、点、下划线和短横线" rules={[{ required: true, message: "请输入用户名" }, { pattern: /^[a-zA-Z0-9._-]{3,64}$/, message: "用户名格式不正确" }]}><Input autoComplete="off" /></Form.Item>
                    <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: "请输入显示名称" }]}><Input /></Form.Item>
                    <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} /></Form.Item>
                    <Form.Item name="temporaryPassword" label="临时密码" extra="至少 10 位，用户首次登录后必须修改" rules={[{ required: true, message: "请输入临时密码" }, { min: 10, message: "临时密码至少需要 10 位" }]}><Input.Password autoComplete="new-password" /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setCreateOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={createMutation.isPending} icon={<UserRoundPlus className="size-4" />}>创建账号</Button></Space>
                </Form>
            </Modal>

            <Modal title={`重置 ${resettingUser?.displayName || "用户"} 的密码`} open={Boolean(resettingUser)} footer={null} onCancel={() => setResettingUser(null)} destroyOnHidden>
                <p className="mb-5 text-sm leading-6 text-stone-500">保存后，该用户的全部现有会话会立即失效，下次登录必须修改临时密码。</p>
                <Form form={resetForm} layout="vertical" requiredMark={false} onFinish={({ temporaryPassword }) => resettingUser && resetMutation.mutate({ id: resettingUser.id, temporaryPassword })}>
                    <Form.Item name="temporaryPassword" label="新临时密码" rules={[{ required: true, message: "请输入临时密码" }, { min: 10, message: "临时密码至少需要 10 位" }]}><Input.Password autoComplete="new-password" /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setResettingUser(null)}>取消</Button><Button type="primary" htmlType="submit" loading={resetMutation.isPending}>确认重置</Button></Space>
                </Form>
            </Modal>

            <Modal title={`调整 ${roleUser?.displayName || "用户"} 的角色`} open={Boolean(roleUser)} footer={null} onCancel={() => setRoleUser(null)} destroyOnHidden>
                <p className="mb-5 text-sm leading-6 text-stone-500">角色变更立即生效。降级为普通用户后，该账号将失去平台管理入口。</p>
                <Form layout="vertical" requiredMark={false} onFinish={() => roleUser && roleMutation.mutate({ id: roleUser.id, role: roleValue })}>
                    <Form.Item label="角色">
                        <Select value={roleValue} onChange={setRoleValue} options={[{ value: "admin", label: "管理员" }, { value: "user", label: "普通用户" }]} />
                    </Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setRoleUser(null)}>取消</Button><Button type="primary" htmlType="submit" loading={roleMutation.isPending}>确认调整</Button></Space>
                </Form>
            </Modal>

            <Modal title={`调整 ${groupUser?.displayName || "用户"} 的分组`} open={Boolean(groupUser)} footer={null} onCancel={() => setGroupUser(null)} destroyOnHidden>
                <p className="mb-5 text-sm leading-6 text-stone-500">分组折扣在下次生成或对话提交时生效，已冻结的金额不受影响。</p>
                <Form layout="vertical" requiredMark={false} onFinish={() => groupUser && groupMutation.mutate({ id: groupUser.id, groupId: groupValue || null })}>
                    <Form.Item label="分组">
                        <Select allowClear placeholder="未分组（原价，不限模型）" value={groupValue} onChange={setGroupValue} options={(groupsQuery.data?.groups || []).map((group) => ({ value: group.id, label: `${group.name}${Number(group.discount) !== 1 ? `（×${group.discount}）` : ""}` }))} />
                    </Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setGroupUser(null)}>取消</Button><Button type="primary" htmlType="submit" loading={groupMutation.isPending}>确认调整</Button></Space>
                </Form>
            </Modal>

            <Modal title="账号凭据（仅显示一次）" open={Boolean(credential)} footer={null} onCancel={() => setCredential(null)} destroyOnHidden maskClosable={false}>
                <Alert className="mt-4 mb-4" type="warning" showIcon message="请立即复制并转交给对方，关闭后将无法再次查看该临时密码。" />
                <div className="space-y-3">
                    {[
                        { label: `账号（${credential?.displayName || ""}）`, value: credential?.username || "" },
                        { label: "临时密码", value: credential?.temporaryPassword || "" },
                    ].map((item) => (
                        <div key={item.label} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2.5 dark:border-stone-800">
                            <div className="min-w-0"><div className="text-xs text-stone-500">{item.label}</div><div className="truncate font-mono text-sm font-medium">{item.value}</div></div>
                            <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(item.value, "已复制")}>复制</Button>
                        </div>
                    ))}
                </div>
                <Button type="primary" block className="mt-5" onClick={() => setCredential(null)}>我已保存</Button>
            </Modal>
        </div>
    );
}

function showError(notify: (content: string) => void) {
    return (error: Error) => notify(error.message || "操作失败");
}
