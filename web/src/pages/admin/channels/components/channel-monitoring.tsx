import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Form, InputNumber, Space, Switch, Table, Tag } from "antd";

import { getAdminChannels, type AdminChannel } from "@/services/api/admin-platform";
import { acknowledgeModelChanges, checkChannel, getChannelChecks, saveMonitoring, type MonitoringConfig } from "@/services/api/platform-operations";

export default function ChannelMonitoring({ channel, onClose }: { channel: AdminChannel; onClose: () => void }) {
    const { message, modal } = App.useApp();
    const client = useQueryClient();
    const [form] = Form.useForm<MonitoringConfig>();
    const channels = useQuery({ queryKey: ["admin", "channels"], queryFn: getAdminChannels, refetchInterval: 2500 });
    const current = channels.data?.find((item) => item.id === channel.id) || channel;
    const checks = useQuery({ queryKey: ["admin", "channel-checks", channel.id], queryFn: () => getChannelChecks(channel.id), refetchInterval: current.checking || current.nextCheckAt ? 2500 : false });
    useEffect(() => { const value = channel.monitoring; form.setFieldsValue({ intervalMinutes: value?.intervalMinutes || 0, checkModels: value?.checkModels ?? true, balanceThreshold: value?.balanceThreshold ?? null }); }, [channel, form]);
    const refresh = () => { void client.invalidateQueries({ queryKey: ["admin", "channels"] }); void client.invalidateQueries({ queryKey: ["admin", "channel-checks", channel.id] }); };
    const save = useMutation({ mutationFn: (values: MonitoringConfig) => saveMonitoring(channel.id, { intervalMinutes: values.intervalMinutes || 0, checkModels: Boolean(values.checkModels), balanceThreshold: values.balanceThreshold == null || values.balanceThreshold === "" ? null : String(values.balanceThreshold) }), onSuccess: () => { refresh(); message.success("检测配置已保存"); }, onError: (error: Error) => message.error(error.message) });
    const check = useMutation({ mutationFn: () => checkChannel(channel.id), onSuccess: () => { refresh(); message.success("检测已提交到后台"); }, onError: (error: Error) => message.error(error.message) });
    const acknowledge = useMutation({ mutationFn: () => acknowledgeModelChanges(channel.id), onSuccess: refresh, onError: (error: Error) => message.error(error.message) });
    const changes = current.modelChanges;
    return <Drawer title={`${channel.name} · 主动检测`} open onClose={onClose} size={680}>
        <Alert className="mb-6" type="info" showIcon title="默认仅手动检测" description="填写间隔后开启自动检测。检测只读取上游模型列表和渠道余额，不产生生成费用；状态变化时通知管理员。" />
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
            <Form.Item name="intervalMinutes" label="自动检测间隔（分钟）" extra="0 表示关闭自动检测，可随时手动执行。"><InputNumber min={0} precision={0} className="!w-full" /></Form.Item>
            {current.autoDisabledAt ? <Alert className="mb-5" type="warning" showIcon title={`已自动停用 · 调用连续失败 ${current.consecutiveRequestFailures} 次`} description="真实调用连续失败达到平台设置阈值后停止接单；请在渠道编辑中保存为「启用」恢复。" /> : null}
            <Form.Item name="checkModels" label="检查模型列表变化" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="balanceThreshold" label="渠道余额提醒阈值（美元）" extra="仅适用于支持 dashboard/billing 的渠道；留空关闭。查询失败会单独提示，不按零余额处理。"><InputNumber<string> stringMode min="0" className="!w-full" /></Form.Item>
            <Space wrap><Button type="primary" htmlType="submit" loading={save.isPending}>保存配置</Button><Button loading={check.isPending || Boolean(current.checking)} disabled={current.status !== "active"} onClick={() => modal.confirm({ title: "执行已保存的检测配置？", content: "检测会读取上游模型列表和渠道余额，不产生生成费用。请先保存当前配置。", okText: "开始检测", cancelText: "返回", onOk: () => check.mutateAsync() })}>立即检测</Button></Space>
        </Form>
        {changes ? <section className="mt-8 border-t border-border pt-5"><div className="flex items-center justify-between"><h3 className="font-medium">模型列表变更</h3><Button type="text" onClick={() => acknowledge.mutate()} loading={acknowledge.isPending}>已核对</Button></div><p className="mt-2 text-sm text-muted-foreground">新增：{changes.added.join("、") || "无"}</p><p className="mt-2 text-sm text-muted-foreground">移除：{changes.removed.join("、") || "无"}</p><p className="mt-3 text-xs text-muted-foreground">请在模型绑定中调整需要使用的模型。</p></section> : null}
        <h3 className="mb-4 mt-8 font-medium">最近检测</h3>
        {checks.error ? <Alert type="error" title={checks.error.message} /> : <Table rowKey="id" pagination={false} dataSource={checks.data?.checks || []} loading={checks.isPending} columns={[{ title: "结果", dataIndex: "status", width: 85, render: (value: string) => <Tag color={value === "healthy" ? "green" : "red"}>{value === "healthy" ? "正常" : "失败"}</Tag> }, { title: "详情", dataIndex: "detail", render: (value: Record<string, unknown>) => Object.entries(value).map(([key, item]) => <div key={key} className="text-xs leading-5">{key === "modelCount" ? `模型数量：${item}` : String(item)}</div>) }, { title: "时间", dataIndex: "createdAt", width: 140, render: (value: string) => new Date(value).toLocaleString() }]} />}
    </Drawer>;
}
