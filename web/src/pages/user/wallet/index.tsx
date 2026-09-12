import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, QRCode, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import { ArrowDownToLine, Gift, RefreshCw, Ticket, Wallet } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { saveAs } from "file-saver";

import { checkin, createPaymentOrder, getPaymentOrder, getPaymentOrders, getWallet, getWalletEntries, paymentMethodLabels, redeemCode, refreshPaymentOrder, walletEntryLabels, type PaymentMethod, type PaymentOrder, type WalletEntry } from "@/services/api/billing";
import { useUserStore } from "@/stores/use-user-store";

type RechargeValues = { channelId: string; method: PaymentMethod; amount: string };
const statusLabels = { pending: "待支付", paid: "已到账", closed: "已关闭" };

export default function WalletPage() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const [searchParams, setSearchParams] = useSearchParams();
    const [rechargeOpen, setRechargeOpen] = useState(false);
    const [activeOrder, setActiveOrder] = useState<string | null>(searchParams.get("order"));
    const [page, setPage] = useState(1);
    const [orderPage, setOrderPage] = useState(1);
    const [form] = Form.useForm<RechargeValues>();
    const selectedChannel = Form.useWatch("channelId", form);
    const request = useRef<{ fingerprint: string; id: string } | null>(null);
    const overview = useQuery({ queryKey: ["wallet", sessionVersion], queryFn: getWallet });
    const [kind, setKind] = useState("");
    const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
    const ledgerParams = { kind, from: range?.[0].startOf("day").toISOString(), to: range?.[1].add(1, "day").startOf("day").toISOString() };
    const ledger = useQuery({ queryKey: ["wallet-entries", sessionVersion, page, ledgerParams], queryFn: () => getWalletEntries((page - 1) * 50, ledgerParams) });
    const orders = useQuery({ queryKey: ["payment-orders", sessionVersion, orderPage], queryFn: () => getPaymentOrders((orderPage - 1) * 50) });
    const order = useQuery({ queryKey: ["payment-order", sessionVersion, activeOrder], queryFn: () => getPaymentOrder(activeOrder!), enabled: Boolean(activeOrder), refetchInterval: (query) => query.state.data?.order.status === "pending" ? 2500 : false });
    const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ["wallet"] }); void queryClient.invalidateQueries({ queryKey: ["wallet-entries"] }); void queryClient.invalidateQueries({ queryKey: ["payment-orders"] }); };
    const [redeemOpen, setRedeemOpen] = useState(false);
    const [redeemForm] = Form.useForm<{ code: string }>();
    const redeem = useMutation({ mutationFn: (code: string) => redeemCode(code), onSuccess: (result) => { void queryClient.invalidateQueries({ queryKey: ["wallet"] }); void queryClient.invalidateQueries({ queryKey: ["wallet-entries"] }); setRedeemOpen(false); redeemForm.resetFields(); message.success(`兑换成功，到账 ¥${result.amount}`); }, onError: (error: Error) => message.error(error.message) });
    const claim = useMutation({ mutationFn: checkin, onSuccess: (result) => { invalidate(); message.success(result.alreadyCheckedIn ? "今天已经领过签到奖励了" : `签到成功，获得 ¥${result.reward}`); }, onError: (error: Error) => message.error(error.message) });
    const create = useMutation({ mutationFn: createPaymentOrder, onSuccess: ({ order }) => { setActiveOrder(order.id); setRechargeOpen(false); request.current = null; invalidate(); }, onError: (error: Error) => message.error(error.message) });
    const refresh = useMutation({ mutationFn: () => refreshPaymentOrder(activeOrder!), onSuccess: () => { void order.refetch(); invalidate(); }, onError: (error: Error) => message.error(error.message) });
    const orderStatus = order.data?.order.status;
    useEffect(() => { if (orderStatus === "paid") { void queryClient.invalidateQueries({ queryKey: ["wallet"] }); void queryClient.invalidateQueries({ queryKey: ["wallet-entries"] }); void queryClient.invalidateQueries({ queryKey: ["payment-orders"] }); } }, [orderStatus, queryClient]);
    const previousSession = useRef(sessionVersion);
    useEffect(() => { if (previousSession.current !== sessionVersion) { setActiveOrder(null); setRechargeOpen(false); request.current = null; previousSession.current = sessionVersion; } }, [sessionVersion]);

    const submit = (values: RechargeValues) => {
        const body = { ...values, amount: String(values.amount) };
        const fingerprint = JSON.stringify(body);
        if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
        create.mutate({ ...body, requestId: request.current.id });
    };
    const channels = overview.data?.paymentChannels || [];
    const channel = channels.find((item) => item.id === selectedChannel);
    const payment = order.data?.order;
    const wallet = overview.data?.wallet;
    const reward = overview.data?.checkin;
    const summary = overview.data?.summary;
    const exportLedger = () => {
        const lines = [["时间", "类型", "余额变动", "冻结变动", "变动后余额", "说明"].join(","), ...(ledger.data?.entries || []).map((item) => [item.createdAt, walletEntryLabels[item.kind] || item.kind, item.deltaBalance, item.deltaFrozen, item.balanceAfter, item.note].map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))];
        saveAs(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), `余额明细-${dayjs().format("YYYYMMDD")}.csv`);
    };

    return <div className="mx-auto w-full max-w-6xl px-5 py-8 lg:px-10 lg:py-10">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs tracking-[0.2em] text-muted-foreground">创作账户</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">我的余额</h1></div><Wallet className="size-6 text-muted-foreground" /></div>
        {overview.error ? <Alert className="mt-6" type="error" title={overview.error.message} action={<Button onClick={() => void overview.refetch()}>重试</Button>} /> : null}
        <div className="my-8 grid gap-8 border-y border-border py-8 md:grid-cols-[1.3fr_1fr]">
            <div><p className="text-sm text-muted-foreground">可用余额 · 人民币</p><p className="mt-3 font-mono text-4xl tracking-tight sm:text-5xl">¥ {wallet?.balance ?? "—"}</p><p className="mt-3 text-sm text-muted-foreground">生成中冻结 ¥{wallet?.frozen ?? "—"}</p><Button className="mt-6" type="primary" size="large" icon={<ArrowDownToLine className="size-4" />} disabled={!channels.length} onClick={() => { form.resetFields(); request.current = null; setRechargeOpen(true); }}>充值余额</Button><Button className="ml-2" size="large" icon={<Ticket className="size-4" />} onClick={() => { redeemForm.resetFields(); setRedeemOpen(true); }}>兑换码</Button>{!channels.length && !overview.isPending ? <p className="mt-2 text-xs text-muted-foreground">充值渠道暂未开放</p> : null}</div>
            <div className="flex flex-col items-start justify-center md:border-l md:border-border md:pl-10"><Gift className="mb-4 size-6" /><h2 className="text-lg font-medium">每天来，给灵感加一点余额</h2><p className="mb-5 mt-2 text-sm leading-6 text-muted-foreground">{reward?.enabled ? `今日随机奖励 ¥${reward.rewardMin} – ¥${reward.rewardMax}` : "签到奖励暂未开放"}<br />每天按北京时间计算，领取后直接计入余额。</p><Button disabled={!reward?.enabled || reward.checkedIn} loading={claim.isPending} onClick={() => claim.mutate()}>{reward?.checkedIn ? "今天已签到" : "领取今日奖励"}</Button></div>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">余额、签到奖励和兑换码到账金额永久保留，不按周期清零。</p>
        {summary ? <div className="mb-8 grid gap-6 border-b border-border pb-8 sm:grid-cols-2 lg:grid-cols-4">{[["本月实付", summary.spent], ["本月充值 / 兑换", summary.recharge], ["本月公益 / 邀请", summary.grants], ["本月签到", summary.checkin]].map(([label, value]) => <div key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 font-mono text-xl">¥{value}</p></div>)}</div> : null}
        <Tabs items={[
            { key: "ledger", label: "余额明细", children: <><Space wrap className="mb-4"><Select className="w-40" value={kind} onChange={(value) => { setKind(value); setPage(1); }} options={[{ value: "", label: "全部类型" }, ...Object.entries(walletEntryLabels).map(([value, label]) => ({ value, label }))]} /><DatePicker.RangePicker value={range} onChange={(value) => { setRange(value as [Dayjs, Dayjs] | null); setPage(1); }} /><Button disabled={!ledger.data?.entries.length} onClick={exportLedger}>导出当前页 CSV</Button></Space><Table<WalletEntry> rowKey="id" loading={ledger.isPending} dataSource={ledger.data?.entries || []} scroll={{ x: 760 }} pagination={{ current: page, pageSize: 50, total: ledger.data?.total || 0, showSizeChanger: false, onChange: setPage }} columns={[
                { title: "时间", dataIndex: "createdAt", render: (value: string) => dayjs(value).format("MM-DD HH:mm:ss") },
                { title: "类型", dataIndex: "kind", render: (kind: string) => walletEntryLabels[kind] || kind },
                { title: "余额变动", dataIndex: "deltaBalance", render: (value: string) => <span className="font-mono">{Number(value) > 0 ? "+" : ""}{value}</span> },
                { title: "冻结变动", dataIndex: "deltaFrozen", render: (value: string) => <span className="font-mono">{value}</span> },
                { title: "变动后余额", dataIndex: "balanceAfter", render: (value: string) => <span className="font-mono">¥{value}</span> },
                { title: "说明", dataIndex: "note" },
            ]} />{ledger.error ? <Alert type="error" title={ledger.error.message} /> : null}</> },
            { key: "orders", label: "充值订单", children: <><Table<PaymentOrder> rowKey="id" loading={orders.isPending} dataSource={orders.data?.orders || []} pagination={false} scroll={{ x: 600 }} columns={[
                { title: "创建时间", dataIndex: "createdAt", render: (value: string) => dayjs(value).format("MM-DD HH:mm") },
                { title: "支付方式", dataIndex: "method", render: (value: PaymentMethod) => paymentMethodLabels[value] },
                { title: "金额", dataIndex: "amount", render: (value: string) => `¥${value}` },
                { title: "状态", dataIndex: "status", render: (value: PaymentOrder["status"]) => <Tag color={value === "paid" ? "success" : "default"}>{statusLabels[value]}</Tag> },
                { title: "", key: "actions", render: (_, row) => <Button type="text" onClick={() => setActiveOrder(row.id)}>查看订单</Button> },
            ]} /><div className="mt-4 flex justify-end gap-2"><Button disabled={orderPage === 1} onClick={() => setOrderPage((p) => p - 1)}>上一页</Button><Button disabled={(orders.data?.orders.length || 0) < 50} onClick={() => setOrderPage((p) => p + 1)}>下一页</Button></div>{orders.error ? <Alert type="error" title={orders.error.message} /> : null}</> },
        ]} />
        <Drawer title="兑换码充值" open={redeemOpen} onClose={() => setRedeemOpen(false)} destroyOnHidden>
            <p className="mb-5 text-sm leading-6 text-muted-foreground">输入管理员发放的兑换码，金额直接计入余额；每个兑换码只能兑换一次。</p>
            <Form form={redeemForm} layout="vertical" onFinish={({ code }) => redeem.mutate(code.trim())}>
                <Form.Item name="code" label="兑换码" rules={[{ required: true, message: "请输入兑换码" }]}><Input.Password size="large" placeholder="CD-xxxxxxxx" autoComplete="off" /></Form.Item>
                <Button type="primary" htmlType="submit" block loading={redeem.isPending}>立即兑换</Button>
            </Form>
        </Drawer>
        <Drawer title="充值余额" open={rechargeOpen} onClose={() => setRechargeOpen(false)} destroyOnHidden>
            <Form<RechargeValues> form={form} layout="vertical" onFinish={submit} initialValues={{ amount: "10.00" }}>
                <Form.Item name="amount" label="充值金额（元）" rules={[{ required: true, message: "请输入充值金额" }]}><InputNumber<string> stringMode className="!w-full" min="0.01" precision={2} prefix="¥" size="large" /></Form.Item>
                <Form.Item name="channelId" label="充值渠道" rules={[{ required: true, message: "请选择充值渠道" }]}><Select options={channels.map((item) => ({ value: item.id, label: item.name }))} onChange={(id) => form.setFieldValue("method", channels.find((item) => item.id === id)?.methods[0])} /></Form.Item>
                <Form.Item name="method" label="支付方式" rules={[{ required: true, message: "请选择支付方式" }]}><Select options={(channel?.methods || []).map((method) => ({ value: method, label: paymentMethodLabels[method] }))} /></Form.Item>
                <Button type="primary" htmlType="submit" block loading={create.isPending}>创建充值订单</Button>
            </Form>
        </Drawer>
        <Drawer title="充值订单" open={Boolean(activeOrder)} onClose={() => { setActiveOrder(null); if (searchParams.has("order")) setSearchParams({}, { replace: true }); }} destroyOnHidden>
            {payment ? <><div className="mb-6 text-center"><p className="font-mono text-4xl">¥{payment.amount}</p><Tag className="mt-3" color={payment.status === "paid" ? "success" : "default"}>{statusLabels[payment.status]}</Tag></div>{payment.status === "pending" && payment.paymentUrl && dayjs(payment.expiresAt).isAfter(dayjs()) ? <div className="mb-6 flex flex-col items-center gap-4"><QRCode value={payment.paymentUrl} size={220} /><p className="text-sm text-muted-foreground">使用{paymentMethodLabels[payment.method]}扫码支付</p>{/^https:\/\//.test(payment.paymentUrl) ? <Button href={payment.paymentUrl} target="_blank" rel="noopener noreferrer">打开支付页面</Button> : null}</div> : null}
                {payment.status === "paid" ? <Alert type="success" showIcon title="充值成功，余额已到账" /> : payment.status === "pending" && !dayjs(payment.expiresAt).isAfter(dayjs()) ? <Alert type="info" showIcon title="订单已过有效期，正在确认支付结果" /> : null}
                <Descriptions className="mt-6" column={1} items={[{ key: "id", label: "订单编号", children: <Typography.Text copyable className="break-all">{payment.id}</Typography.Text> }, { key: "method", label: "支付方式", children: paymentMethodLabels[payment.method] }, { key: "expiry", label: "有效期至", children: dayjs(payment.expiresAt).format("YYYY-MM-DD HH:mm:ss") }]} />
                {payment.status === "pending" ? <Space className="mt-6"><Button icon={<RefreshCw className="size-4" />} loading={refresh.isPending} onClick={() => refresh.mutate()}>我已支付，刷新状态</Button></Space> : null}
            </> : order.error ? <Alert type="error" title={order.error.message} /> : <Empty description="正在读取订单" />}
        </Drawer>
    </div>;
}
