import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Descriptions, Drawer, Empty, Form, Input, InputNumber, QRCode, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import { ArrowDownToLine, Copy, RefreshCw, Ticket, Users, Wallet } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";

import { useCopyText } from "@/hooks/use-copy-text";
import { createPaymentOrder, getPaymentOrder, getPaymentOrders, getWallet, paymentMethodLabels, redeemCode, refreshPaymentOrder, type PaymentMethod, type PaymentOrder } from "@/services/api/billing";
import { getReferrals, type Referral } from "@/services/api/platform-operations";
import { generateAffiliateLink } from "@/lib/affiliate";
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
    const [orderPage, setOrderPage] = useState(1);
    const [referralPage, setReferralPage] = useState(1);
    const copy = useCopyText();
    const [form] = Form.useForm<RechargeValues>();
    const selectedChannel = Form.useWatch("channelId", form);
    const request = useRef<{ fingerprint: string; id: string } | null>(null);
    const overview = useQuery({ queryKey: ["wallet", sessionVersion], queryFn: getWallet });
    const orders = useQuery({ queryKey: ["payment-orders", sessionVersion, orderPage], queryFn: () => getPaymentOrders((orderPage - 1) * 50) });
    const referrals = useQuery({ queryKey: ["referrals", sessionVersion, referralPage], queryFn: () => getReferrals((referralPage - 1) * 50) });
    const order = useQuery({ queryKey: ["payment-order", sessionVersion, activeOrder], queryFn: () => getPaymentOrder(activeOrder!), enabled: Boolean(activeOrder), refetchInterval: (query) => query.state.data?.order.status === "pending" ? 2500 : false });
    const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ["wallet"] }); void queryClient.invalidateQueries({ queryKey: ["payment-orders"] }); };
    const [redeemOpen, setRedeemOpen] = useState(false);
    const [redeemForm] = Form.useForm<{ code: string }>();
    const redeem = useMutation({ mutationFn: (code: string) => redeemCode(code), onSuccess: (result) => { void queryClient.invalidateQueries({ queryKey: ["wallet"] }); setRedeemOpen(false); redeemForm.resetFields(); message.success(`兑换成功，到账 ¥${result.amount}`); }, onError: (error: Error) => message.error(error.message) });
    const create = useMutation({ mutationFn: createPaymentOrder, onSuccess: ({ order }) => { setActiveOrder(order.id); setRechargeOpen(false); request.current = null; invalidate(); }, onError: (error: Error) => message.error(error.message) });
    const refresh = useMutation({ mutationFn: () => refreshPaymentOrder(activeOrder!), onSuccess: () => { void order.refetch(); invalidate(); }, onError: (error: Error) => message.error(error.message) });
    const orderStatus = order.data?.order.status;
    useEffect(() => { if (orderStatus === "paid") { void queryClient.invalidateQueries({ queryKey: ["wallet"] }); void queryClient.invalidateQueries({ queryKey: ["payment-orders"] }); } }, [orderStatus, queryClient]);
    const previousSession = useRef(sessionVersion);
    useEffect(() => { if (previousSession.current !== sessionVersion) { setActiveOrder(null); setRechargeOpen(false); setReferralPage(1); request.current = null; previousSession.current = sessionVersion; } }, [sessionVersion]);

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
    const referral = referrals.data;
    const summary = overview.data?.summary;

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-stone-500 mb-1">
                        <Wallet className="size-4 text-amber-500" />
                        <span className="text-xs font-semibold uppercase tracking-wider">Wallet</span>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">我的钱包</h1>
                    <p className="mt-1 text-sm text-stone-500">
                        余额充值、兑换码核销与邀请好友返利，到账金额永久有效不按周期清零。
                    </p>
                </div>
            </div>
        {overview.error ? <Alert className="mt-6" type="error" title={overview.error.message} action={<Button onClick={() => void overview.refetch()}>重试</Button>} /> : null}
        {Number(wallet?.balance) < 0 ? <Alert type="warning" showIcon title="账户有待结清的生成费用" description="实际费用已完整入账，新的生成已暂停；充值、兑换等到账金额会先抵扣欠费。" /> : null}
        <div className="rounded-xl border border-border">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
                <div>
                    <p className="text-xs text-muted-foreground">可用余额 · 人民币</p>
                    <p className="mt-1 font-mono text-3xl tracking-tight">¥ {wallet?.balance ?? "—"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">生成中冻结 ¥{wallet?.frozen ?? "—"}</p>
                </div>
                <div className="flex flex-col items-start gap-1.5">
                    <Space>
                        <Button type="primary" icon={<ArrowDownToLine className="size-4" />} disabled={!channels.length} onClick={() => { form.resetFields(); request.current = null; setRechargeOpen(true); }}>充值余额</Button>
                        <Button icon={<Ticket className="size-4" />} onClick={() => { redeemForm.resetFields(); setRedeemOpen(true); }}>兑换码</Button>
                    </Space>
                    {!channels.length && !overview.isPending ? <p className="text-xs text-muted-foreground">充值渠道暂未开放</p> : null}
                </div>
            </div>
            {summary ? <div className="grid grid-cols-2 border-t border-border sm:grid-cols-4">{[["本月实付", summary.spent], ["本月充值 / 兑换", summary.recharge], ["本月公益 / 邀请", summary.grants], ["本月签到", summary.checkin]].map(([label, value]) => <div key={label} className="px-5 py-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 font-mono text-base">¥{value}</p></div>)}</div> : null}
        </div>
        <div className="rounded-xl border border-border px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Users className="size-4 text-indigo-500" />
                        <span className="text-sm font-medium">邀请好友</span>
                    </div>
                    {referral?.code ? (
                        <div className="flex items-center gap-2 rounded-md bg-stone-100 px-2.5 py-1 dark:bg-stone-800/80">
                            <span className="text-xs text-muted-foreground">专属邀请码</span>
                            <span className="font-mono text-sm font-bold tracking-wider text-foreground">{referral.code}</span>
                            <Button type="text" size="small" className="!h-6 !w-6 !p-0 text-muted-foreground hover:text-foreground" onClick={() => copy(referral.code, "邀请码已复制")} title="复制邀请码"><Copy className="size-3.5" /></Button>
                        </div>
                    ) : null}
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>已邀请 <span className="font-mono font-medium text-foreground">{referral?.summary.invited ?? "—"}</span></span>
                    <span>累计返利 <span className="font-mono font-medium text-foreground">¥{referral?.summary.earned ?? "—"}</span></span>
                    <span>返利比例 <span className="font-mono font-medium text-foreground">{referral ? (referral.enabled ? `${referral.percent}%` : "暂未开放") : "—"}</span></span>
                </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input readOnly value={referral?.code ? generateAffiliateLink(referral.code) : ""} className="max-w-lg font-mono text-xs" placeholder="邀请链接" />
                <Button icon={<Copy className="size-4" />} disabled={!referral} onClick={() => referral?.code && copy(generateAffiliateLink(referral.code), "邀请链接已复制")}>复制链接</Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">好友通过邀请链接注册后，每笔实际支付的充值按当前比例返利到余额；注册仍需有效邀请码，签到和兑换码不参与返利。</p>
            {referrals.error ? <Alert className="mt-3" type="error" title={referrals.error.message} /> : null}
        </div>
        <Tabs items={[
            { key: "orders", label: "充值订单", children: <><Table<PaymentOrder> rowKey="id" loading={orders.isPending} dataSource={orders.data?.orders || []} pagination={false} scroll={{ x: 600 }} columns={[
                { title: "创建时间", dataIndex: "createdAt", render: (value: string) => dayjs(value).format("MM-DD HH:mm") },
                { title: "支付方式", dataIndex: "method", render: (value: PaymentMethod) => paymentMethodLabels[value] },
                { title: "金额", dataIndex: "amount", render: (value: string) => `¥${value}` },
                { title: "状态", dataIndex: "status", render: (value: PaymentOrder["status"]) => <Tag color={value === "paid" ? "success" : "default"}>{statusLabels[value]}</Tag> },
                { title: "", key: "actions", render: (_, row) => <Button type="text" onClick={() => setActiveOrder(row.id)}>查看订单</Button> },
            ]} /><div className="mt-4 flex justify-end gap-2"><Button disabled={orderPage === 1} onClick={() => setOrderPage((p) => p - 1)}>上一页</Button><Button disabled={(orders.data?.orders.length || 0) < 50} onClick={() => setOrderPage((p) => p + 1)}>下一页</Button></div>{orders.error ? <Alert type="error" title={orders.error.message} /> : null}</> },
            { key: "referrals", label: "邀请记录", children: <><Table<Referral> rowKey="id" loading={referrals.isPending} dataSource={referral?.referrals || []} scroll={{ x: 520 }} pagination={{ current: referralPage, pageSize: 50, total: referral?.summary.invited || 0, showSizeChanger: false, showTotal: (total) => `共 ${total} 条`, onChange: setReferralPage }} columns={[
                { title: "好友", dataIndex: "displayName" },
                { title: "累计返利", dataIndex: "reward", width: 130, render: (value: string) => <span className="font-mono text-xs">¥{value}</span> },
                { title: "注册时间", dataIndex: "createdAt", width: 160, render: (value: string) => <span className="font-mono text-xs text-muted-foreground">{dayjs(value).format("YYYY-MM-DD HH:mm")}</span> },
            ]} /></> },
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
    </div>
    );
}
