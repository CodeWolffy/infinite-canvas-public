import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, InputNumber, Select, Switch, Table, Tag } from "antd";

import { getMailDeliveries, getMailSettings, saveMailSettings, type MailSettings } from "@/services/api/platform-operations";

export default function MailSettingsPanel() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [form] = Form.useForm<MailSettings>();
    const config = useQuery({ queryKey: ["admin", "mail-settings"], queryFn: getMailSettings });
    const deliveries = useQuery({ queryKey: ["admin", "mail-deliveries"], queryFn: getMailDeliveries });
    useEffect(() => { if (config.data) form.setFieldsValue({ ...config.data.settings, mode: config.data.settings.mode || "starttls", port: config.data.settings.port || 587, password: "" }); }, [config.data, form]);
    const save = useMutation({ mutationFn: saveMailSettings, onSuccess: () => { void client.invalidateQueries({ queryKey: ["admin", "mail-settings"] }); message.success("邮件配置已保存"); }, onError: (error: Error) => message.error(error.message) });
    const states: Record<string, string> = { queued: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败" };
    return <section className="mt-10 border-t border-border pt-8"><h2 className="text-xl font-semibold">邮件与通知</h2><p className="mb-6 mt-2 text-sm leading-6 text-muted-foreground">用于邮箱验证、找回密码和管理员异常提醒。管理员绑定并验证邮箱后可接收渠道通知；发送失败保留站内记录，可在修正配置后重新发起验证邮件。</p>
        {config.error ? <Alert type="error" title={config.error.message} /> : <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)} initialValues={{ enabled: false, mode: "starttls", port: 587 }}>
            <Form.Item name="enabled" label="启用邮件服务" valuePropName="checked"><Switch /></Form.Item>
            <div className="grid gap-x-4 sm:grid-cols-2"><Form.Item name="host" label="SMTP 主机"><Input placeholder="smtp.example.com" /></Form.Item><Form.Item name="port" label="端口"><InputNumber min={1} max={65535} precision={0} className="!w-full" /></Form.Item><Form.Item name="mode" label="传输加密"><Select options={[{ value: "starttls", label: "STARTTLS" }, { value: "tls", label: "TLS" }]} /></Form.Item><Form.Item name="from" label="发件邮箱" rules={[{ type: "email" }]}><Input /></Form.Item><Form.Item name="username" label="SMTP 用户名"><Input autoComplete="off" /></Form.Item><Form.Item name="password" label="SMTP 密码或授权码" extra={config.data?.passwordConfigured ? "已配置，留空保留现有密码" : "密码加密保存在服务器"}><Input.Password autoComplete="new-password" /></Form.Item></div>
            <Button type="primary" htmlType="submit" loading={save.isPending}>保存邮件设置</Button>
        </Form>}
        <div className="mb-4 mt-8 flex items-center justify-between"><h3 className="font-medium">最近投递</h3><Button type="text" onClick={() => void deliveries.refetch()}>刷新</Button></div>
        <Table rowKey="id" pagination={false} loading={deliveries.isPending} dataSource={deliveries.data?.deliveries || []} columns={[{ title: "提交时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() }, { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "failed" ? "red" : value === "sent" ? "green" : "default"}>{states[value] || value}</Tag> }]} />
    </section>;
}
