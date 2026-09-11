import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Form, Input, Modal, QRCode, Space, Table, Tag } from "antd";
import { Mail, Monitor, ShieldCheck } from "lucide-react";
import dayjs from "dayjs";

import { bindEmail, disableMfa, enableMfa, getAccountSecurity, getLoginSessions, revokeLoginSession, revokeOtherSessions, setupMfa, type SecurityProof } from "@/services/api/platform-operations";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { useCopyText } from "@/hooks/use-copy-text";

export default function SecuritySettings() {
    const { message, modal } = App.useApp();
    const client = useQueryClient();
    const session = useUserStore((state) => state.sessionVersion);
    const clearSession = useUserStore((state) => state.clearSession);
    const copy = useCopyText();
    const [action, setAction] = useState<"email" | "setup" | "disable" | null>(null);
    const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
    const [code, setCode] = useState("");
    const [recovery, setRecovery] = useState("");
    const [form] = Form.useForm<SecurityProof & { email: string }>();
    const security = useQuery({ queryKey: ["account-security", session], queryFn: getAccountSecurity });
    const devices = useQuery({ queryKey: ["login-sessions", session], queryFn: getLoginSessions });
    const fail = (error: Error) => { if (error.name !== "AbortError") message.error(error.message); };
    const refresh = () => { void client.invalidateQueries({ queryKey: ["account-security"] }); void client.invalidateQueries({ queryKey: ["login-sessions"] }); };
    useEffect(() => { setAction(null); setSetup(null); setRecovery(""); setCode(""); }, [session]);
    useEffect(() => { if (!setup) form.resetFields(); }, [session, setup, form]);
    const submit = useMutation({ mutationFn: async (values: SecurityProof & { email: string }) => {
        const version = useUserStore.getState().sessionVersion;
        if (action === "setup") { const result = await setupMfa(values); assertCurrentSession(version); setSetup(result); return; }
        if (action === "email") { const result = await bindEmail(values); assertCurrentSession(version); message.success(result.message); }
        else { await disableMfa(values); assertCurrentSession(version); message.success("两步验证已关闭"); }
        setAction(null); refresh();
    }, onError: fail });
    const enable = useMutation({ mutationFn: async () => { const version = useUserStore.getState().sessionVersion; return { result: await enableMfa(code), version }; }, onSuccess: ({ result, version }) => { assertCurrentSession(version); setRecovery(result.recoveryCode); setSetup(null); setAction(null); refresh(); message.success("两步验证已启用，其他设备已退出"); }, onError: fail });
    const revoke = useMutation({ mutationFn: async (id: string) => { const version = useUserStore.getState().sessionVersion; return { result: await revokeLoginSession(id), version }; }, onSuccess: ({ result, version }) => { assertCurrentSession(version); if (result.current) clearSession(); else refresh(); }, onError: fail });
    const revokeOthers = useMutation({ mutationFn: revokeOtherSessions, onSuccess: () => { refresh(); message.success("其他设备已退出"); }, onError: fail });
    const open = (next: NonNullable<typeof action>) => { form.resetFields(); setCode(""); setSetup(null); setAction(next); };
    const current = security.data?.security;
    return <>
        <Card title={<span className="inline-flex items-center gap-2"><ShieldCheck className="size-4" />账号保护</span>} loading={security.isPending}>
            {security.error ? <Alert type="error" title={security.error.message} /> : <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2"><Mail className="size-4" /><span>找回邮箱</span>{current?.emailVerifiedAt ? <Tag color="green">已验证</Tag> : <Tag>未绑定</Tag>}</div><p className="mt-2 text-sm text-muted-foreground">{current?.email || "绑定后可自助找回密码，并接收相关通知。"}</p></div><Button onClick={() => open("email")}>{current?.email ? "更换邮箱" : "绑定邮箱"}</Button></div>
                <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6"><div><div className="flex items-center gap-2"><ShieldCheck className="size-4" /><span>两步验证</span><Tag color={current?.mfaEnabled ? "green" : "default"}>{current?.mfaEnabled ? "已启用" : "未启用"}</Tag></div><p className="mt-2 max-w-lg text-sm text-muted-foreground">登录时同时验证密码和验证器验证码，建议所有管理员开启。</p></div><Button danger={current?.mfaEnabled} onClick={() => open(current?.mfaEnabled ? "disable" : "setup")}>{current?.mfaEnabled ? "关闭两步验证" : "绑定验证器"}</Button></div>
            </div>}
        </Card>
        <Card title={<span className="inline-flex items-center gap-2"><Monitor className="size-4" />登录设备</span>} extra={<Button type="text" disabled={(devices.data?.sessions.length || 0) < 2} loading={revokeOthers.isPending} onClick={() => modal.confirm({ title: "退出其他所有设备？", content: "当前设备将保持登录。", onOk: () => revokeOthers.mutateAsync() })}>退出其他设备</Button>}>
            {devices.error ? <Alert type="error" title={devices.error.message} /> : <Table rowKey="id" loading={devices.isPending} dataSource={devices.data?.sessions || []} pagination={false} scroll={{ x: 650 }} columns={[
                { title: "设备", dataIndex: "userAgent", ellipsis: true, render: (value: string, item) => <span>{item.current ? <Tag color="green">当前</Tag> : null}{value || "未记录设备信息"}</span> },
                { title: "IP", dataIndex: "ip", width: 150 }, { title: "登录时间", dataIndex: "createdAt", width: 150, render: (value: string) => dayjs(value).format("MM-DD HH:mm") },
                { title: "操作", width: 90, render: (_, item) => <Button type="text" danger loading={revoke.isPending && revoke.variables === item.id} onClick={() => modal.confirm({ title: item.current ? "退出当前设备？" : "退出此设备？", onOk: () => revoke.mutateAsync(item.id) })}>退出</Button> },
            ]} />}
        </Card>
        <Modal title={action === "email" ? "验证找回邮箱" : action === "disable" ? "关闭两步验证" : "绑定验证器"} open={Boolean(action)} onCancel={() => { setAction(null); setSetup(null); }} footer={null} forceRender>
            {setup ? <div className="space-y-5 py-3"><p className="text-sm text-muted-foreground">用验证器扫描二维码，再输入生成的验证码。绑定页面 5 分钟内有效。</p><div className="flex justify-center"><QRCode value={setup.uri} /></div><Input readOnly value={setup.secret} addonBefore="手动密钥" /><Input autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="验证器中的最新验证码" /><Button type="primary" block loading={enable.isPending} disabled={!code} onClick={() => enable.mutate()}>确认启用</Button></div> : <Form form={form} layout="vertical" className="pt-4" onFinish={(values) => submit.mutate(values)}>
                {action === "email" ? <Form.Item name="email" label="新邮箱" extra="验证新邮箱成功后才会替换当前邮箱。" rules={[{ required: true, type: "email" }]}><Input autoComplete="email" /></Form.Item> : null}
                <Form.Item name="password" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
                {current?.mfaEnabled ? <Form.Item name="code" label="验证器验证码" rules={[{ required: true }]}><Input autoComplete="one-time-code" /></Form.Item> : null}
                <Button type="primary" htmlType="submit" block loading={submit.isPending}>{action === "email" ? "发送验证邮件" : action === "disable" ? "确认关闭" : "继续绑定"}</Button>
            </Form>}
        </Modal>
        <Modal title="保存一次性恢复码" open={Boolean(recovery)} closable={false} mask={{ closable: false }} footer={<Button type="primary" onClick={() => setRecovery("")}>我已妥善保存</Button>}>
            <Alert type="warning" showIcon title="恢复码只在此显示一次" description="丢失验证器时，可用它完成登录并关闭两步验证。恢复后请重新绑定验证器。" />
            <Space.Compact className="mt-5 w-full"><Input readOnly value={recovery} /><Button onClick={() => void copy(recovery)}>复制</Button></Space.Compact>
        </Modal>
    </>;
}
