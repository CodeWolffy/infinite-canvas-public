import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import { CreditCard, Plus } from "lucide-react";
import dayjs from "dayjs";

import { adjustBalance, getAdminPaymentOrders, getAdminWalletEntries, getPaymentChannels, paymentMethodLabels, paymentProviderLabels, reconcilePaymentOrder, savePaymentChannel, walletEntryLabels, type PaymentChannel, type PaymentMethod, type PaymentOrder, type PaymentProvider, type WalletEntry } from "@/services/api/billing";
import { getAdminUsers } from "@/services/api/admin-users";
import CostReport from "./components/cost-report";

type ChannelValues = Omit<PaymentChannel, "id" | "configuredSecrets">;
const fields: Record<PaymentProvider, Array<[string, string, boolean]>> = {
    epay: [["baseUrl", "支付网关 HTTPS 地址", false], ["partnerId", "商户 ID", false], ["key", "商户密钥", true]],
    alipay: [["appId", "应用 App ID", false], ["sellerId", "收款支付宝用户 ID", false], ["privateKey", "应用私钥", true], ["publicKey", "支付宝公钥", false]],
    wechat: [["appId", "应用 App ID", false], ["mchId", "商户号", false], ["serialNo", "商户证书序列号", false], ["privateKey", "商户私钥（PEM）", true], ["apiV3Key", "API v3 密钥", true], ["publicKeyId", "微信支付公钥 ID", false], ["publicKey", "微信支付公钥（PEM）", false]],
};
const statusLabels = { pending: "待支付", paid: "已到账", closed: "已关闭" };

export default function BillingPage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [editing, setEditing] = useState<PaymentChannel | null | undefined>();
    const [tab, setTab] = useState("channels");
    const [page, setPage] = useState(1);
    const [status, setStatus] = useState("");
    const [adjustmentOpen, setAdjustmentOpen] = useState(false);
    const [adjustmentID, setAdjustmentID] = useState("");
    const [form] = Form.useForm<ChannelValues>();
    const [balanceForm] = Form.useForm<{ userId: string; amount: string; note: string }>();
    const provider: PaymentProvider = Form.useWatch("provider", form) || "epay";
    const channels = useQuery({ queryKey: ["payment-channels"], queryFn: getPaymentChannels });
    const orders = useQuery({ queryKey: ["admin-payment-orders", status, page], queryFn: () => getAdminPaymentOrders(status, (page - 1) * 50), enabled: tab === "orders" });
    const ledger = useQuery({ queryKey: ["admin-wallet-entries", page], queryFn: () => getAdminWalletEntries("", (page - 1) * 50), enabled: tab === "ledger" });
    const users = useQuery({ queryKey: ["admin-users"], queryFn: getAdminUsers, enabled: adjustmentOpen });
    const save = useMutation({ mutationFn: (values: ChannelValues) => savePaymentChannel(editing?.id, values), onSuccess: () => { setEditing(undefined); void client.invalidateQueries({ queryKey: ["payment-channels"] }); message.success("支付渠道已保存"); }, onError: (error: Error) => message.error(error.message) });
    const reconcile = useMutation({ mutationFn: reconcilePaymentOrder, onSuccess: () => { void orders.refetch(); message.success("查单完成"); }, onError: (error: Error) => message.error(error.message) });
    const adjust = useMutation({ mutationFn: (values: { userId: string; amount: string; note: string }) => adjustBalance(values.userId, { amount: String(values.amount), note: values.note, requestId: adjustmentID }), onSuccess: () => { setAdjustmentOpen(false); void client.invalidateQueries({ queryKey: ["admin-wallet-entries"] }); void client.invalidateQueries({ queryKey: ["admin-users"] }); message.success("余额已调整"); }, onError: (error: Error) => message.error(error.message) });
    const openChannel = (channel: PaymentChannel | null) => { setEditing(channel); form.resetFields(); form.setFieldsValue(channel || { name: "", provider: "epay", methods: ["alipay", "wxpay"], enabled: false, config: {} }); };
    const currentError = tab === "channels" ? channels.error : tab === "orders" ? orders.error : ledger.error;

    return <div className="w-full px-5 py-8 lg:px-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><CreditCard className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">充值与账务</h1><p className="mt-2 text-sm text-muted-foreground">统一管理支付渠道、充值订单和余额变动。</p></div><Space><Button onClick={() => { balanceForm.resetFields(); setAdjustmentID(crypto.randomUUID()); setAdjustmentOpen(true); }}>调整用户余额</Button><Button type="primary" icon={<Plus className="size-4" />} onClick={() => openChannel(null)}>添加支付渠道</Button></Space></div>
        {currentError ? <Alert className="mb-5" type="error" title={currentError.message} /> : null}
        <Tabs activeKey={tab} onChange={(key) => { setTab(key); setPage(1); }} items={[
            { key: "costs", label: "成本与公益补贴", children: <CostReport /> },
            { key: "channels", label: "支付渠道", children: <Table<PaymentChannel> rowKey="id" dataSource={channels.data?.channels || []} loading={channels.isPending} pagination={false} scroll={{ x: 650 }} columns={[
                { title: "渠道名称", dataIndex: "name" }, { title: "接入方式", dataIndex: "provider", render: (value: PaymentProvider) => paymentProviderLabels[value] },
                { title: "支付方式", dataIndex: "methods", render: (values: PaymentMethod[]) => values.map((method) => <Tag key={method}>{paymentMethodLabels[method]}</Tag>) },
                { title: "状态", dataIndex: "enabled", render: (enabled: boolean) => <Tag color={enabled ? "success" : "default"}>{enabled ? "已启用" : "已停用"}</Tag> },
                { title: "", key: "edit", render: (_, row) => <Button type="text" onClick={() => openChannel(row)}>配置</Button> },
            ]} /> },
            { key: "orders", label: "充值订单", children: <><Select className="mb-4 w-40" value={status} options={[{ value: "", label: "全部状态" }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} onChange={(value) => { setStatus(value); setPage(1); }} /><Table<PaymentOrder> rowKey="id" dataSource={orders.data?.orders || []} loading={orders.isPending} pagination={false} scroll={{ x: 850 }} columns={[
                { title: "用户", dataIndex: "username" }, { title: "时间", dataIndex: "createdAt", render: (value: string) => dayjs(value).format("MM-DD HH:mm") },
                { title: "支付方式", dataIndex: "method", render: (value: PaymentMethod) => paymentMethodLabels[value] }, { title: "金额", dataIndex: "amount", render: (value: string) => `¥${value}` },
                { title: "订单号", dataIndex: "id", ellipsis: true }, { title: "状态", dataIndex: "status", render: (value: PaymentOrder["status"]) => <Tag color={value === "paid" ? "success" : "default"}>{statusLabels[value]}</Tag> },
                { title: "操作", key: "reconcile", render: (_, row) => <Button type="text" disabled={row.status === "paid"} loading={reconcile.isPending && reconcile.variables === row.id} onClick={() => reconcile.mutate(row.id)}>服务端查单</Button> },
            ]} /></> },
            { key: "ledger", label: "余额账本", children: <Table<WalletEntry> rowKey="id" dataSource={ledger.data?.entries || []} loading={ledger.isPending} pagination={false} scroll={{ x: 950 }} columns={[
                { title: "用户", dataIndex: "username" }, { title: "时间", dataIndex: "createdAt", render: (value: string) => dayjs(value).format("MM-DD HH:mm:ss") },
                { title: "类型", dataIndex: "kind", render: (value: string) => walletEntryLabels[value] || value }, { title: "余额变动", dataIndex: "deltaBalance" }, { title: "冻结变动", dataIndex: "deltaFrozen" }, { title: "变动后余额", dataIndex: "balanceAfter" }, { title: "说明", dataIndex: "note" },
            ]} /> },
        ]} />
        {tab === "orders" || tab === "ledger" ? <div className="mt-4 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button disabled={(tab === "orders" ? orders.data?.orders.length || 0 : ledger.data?.entries.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>下一页</Button></div> : null}
        <Modal title={editing ? "配置支付渠道" : "添加支付渠道"} open={editing !== undefined} onCancel={() => setEditing(undefined)} footer={null} destroyOnHidden width={600}>
            <Form<ChannelValues> form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
                <div className="grid grid-cols-2 gap-4"><Form.Item name="name" label="渠道名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="provider" label="接入方式" rules={[{ required: true }]}><Select disabled={Boolean(editing)} options={Object.entries(paymentProviderLabels).map(([value, label]) => ({ value, label }))} onChange={(value: PaymentProvider) => { form.setFieldValue("config", {}); form.setFieldValue("methods", value === "epay" ? ["alipay", "wxpay"] : value === "wechat" ? ["wxpay"] : ["alipay"]); }} /></Form.Item></div>
                <Form.Item name="methods" label="开放支付方式" rules={[{ required: true }]}><Select mode="multiple" options={(provider === "epay" ? ["alipay", "wxpay"] as const : provider === "wechat" ? ["wxpay"] as const : ["alipay"] as const).map((method) => ({ value: method, label: paymentMethodLabels[method] }))} /></Form.Item>
                {fields[provider].map(([key, label, secret]) => <Form.Item key={`${provider}-${key}`} name={["config", key]} label={label} rules={[{ required: !secret || !editing?.configuredSecrets.includes(key), message: `请填写${label}` }]} extra={secret && editing?.configuredSecrets.includes(key) ? "已配置，留空保持原值" : undefined}>{key.toLowerCase().includes("privatekey") || key === "publicKey" ? <Input.TextArea rows={3} autoComplete="off" placeholder={secret && editing ? "留空保持原值" : label} /> : secret ? <Input.Password autoComplete="new-password" /> : <Input />}</Form.Item>)}
                {provider === "epay" ? <Alert className="mb-4" type="info" title="使用经典易支付协议（MD5）" description="自动查单需要网关提供 api.php 的 order 接口；经典协议仅关闭本站过期支付入口，迟到的验签成功付款仍会入账。" /> : null}
                <Form.Item name="enabled" label="启用渠道" valuePropName="checked"><Switch /></Form.Item><Space className="flex justify-end"><Button onClick={() => setEditing(undefined)}>取消</Button><Button type="primary" htmlType="submit" loading={save.isPending}>保存</Button></Space>
            </Form>
        </Modal>
        <Modal title="调整用户余额" open={adjustmentOpen} onCancel={() => setAdjustmentOpen(false)} footer={null} destroyOnHidden>
            <Form form={balanceForm} layout="vertical" onFinish={(values) => adjust.mutate(values)}><Form.Item name="userId" label="用户" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" loading={users.isPending} options={(users.data || []).map((user) => ({ value: user.id, label: `${user.displayName} · ${user.username}` }))} /></Form.Item><Form.Item name="amount" label="调整金额（元）" extra="正数增加可用余额，负数扣减可用余额，不影响已冻结金额。" rules={[{ required: true }]}><InputNumber<string> stringMode precision={6} className="!w-full" /></Form.Item><Form.Item name="note" label="调整原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item><Button type="primary" htmlType="submit" block loading={adjust.isPending}>确认调整</Button></Form>
        </Modal>
    </div>;
}
