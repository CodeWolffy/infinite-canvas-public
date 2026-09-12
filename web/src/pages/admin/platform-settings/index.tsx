import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, InputNumber, Spin, Switch } from "antd";
import { SlidersHorizontal } from "lucide-react";

import { getPlatformSettings, savePlatformSettings, type PlatformSettings } from "@/services/api/billing";
import MailSettingsPanel from "./components/mail-settings";

export default function PlatformSettingsPage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [form] = Form.useForm<PlatformSettings>();
    const query = useQuery({ queryKey: ["platform-settings"], queryFn: getPlatformSettings });
    const mutation = useMutation({ mutationFn: savePlatformSettings, onSuccess: () => { void client.invalidateQueries({ queryKey: ["platform-settings"] }); void client.invalidateQueries({ queryKey: ["wallet"] }); void client.invalidateQueries({ queryKey: ["referrals"] }); message.success("平台设置已保存"); }, onError: (error: Error) => message.error(error.message) });
    useEffect(() => { if (query.data) form.setFieldsValue(query.data.settings); }, [form, query.data]);

    return <div className="mx-auto w-full max-w-5xl px-5 py-8 lg:px-8">
        <SlidersHorizontal className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">平台运营设置</h1><p className="mb-8 mt-2 text-sm text-muted-foreground">配置公益奖励、生成频控和充值订单规则。</p>
        {query.error ? <Alert type="error" title={query.error.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} /> : query.isPending ? <Spin /> : <Form<PlatformSettings> form={form} layout="vertical" onFinish={(values) => mutation.mutate({ ...values, rewardMin: String(values.rewardMin), rewardMax: String(values.rewardMax), referralPercent: String(values.referralPercent) })}>
            <div className="grid gap-8 border-t border-border py-7 md:grid-cols-[220px_1fr]"><div><h2 className="font-medium">每日签到</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">奖励直接入账。每天按北京时间计算，每位用户只能领取一次，到账金额永久保留。</p></div><div><Form.Item name="checkinEnabled" label="开启签到奖励" valuePropName="checked"><Switch /></Form.Item><div className="grid grid-cols-2 gap-4"><Form.Item name="rewardMin" label="最少奖励（元）" rules={[{ required: true }]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item><Form.Item name="rewardMax" label="最多奖励（元）" dependencies={["rewardMin"]} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => Number(value) >= Number(getFieldValue("rewardMin")) ? Promise.resolve() : Promise.reject(new Error("不能低于最少奖励")) })]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item></div></div></div>
            <div className="grid gap-8 border-t border-border py-7 md:grid-cols-[220px_1fr]"><div><h2 className="font-medium">邀请充值返利</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">好友注册后建立邀请关系，每次真实充值到账时，按当时配置的比例返给邀请人，返利余额永久有效。</p></div><div><Form.Item name="referralEnabled" label="开启邀请充值返利" valuePropName="checked"><Switch /></Form.Item><Form.Item name="referralPercent" label="好友充值返利比例（%）" extra="例如填写 10，好友充值 100 元返利 10 元。注册、兑换码和签到不返利；关闭期间的充值不补发。" rules={[{ required: true }]}><InputNumber<string> stringMode min="0" className="!w-full" /></Form.Item></div></div>
            <div className="grid gap-8 border-t border-border py-7 md:grid-cols-[220px_1fr]"><div><h2 className="font-medium">生成与频控</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">限制对全部服务实例生效。超限不扣款；填 0 代表取消对应限制。</p></div><div><Form.Item name="generationEnabled" label="接受新的生成任务" valuePropName="checked"><Switch /></Form.Item><div className="grid grid-cols-2 gap-4"><Form.Item name="userRPM" label="每账号每分钟提交次数" rules={[{ required: true }]}><InputNumber min={0} precision={0} className="!w-full" /></Form.Item><Form.Item name="ipRPM" label="每 IP 每分钟提交次数" rules={[{ required: true }]}><InputNumber min={0} precision={0} className="!w-full" /></Form.Item></div><Form.Item name="maxAttempts" label="任务最多尝试次数（含首次）" extra="默认 3 次；1 表示关闭自动切换。只在没有文本输出、没有异步任务 ID 时切换，次数耗尽退回冻结余额。" rules={[{ required: true }]}><InputNumber min={1} precision={0} className="!w-full" /></Form.Item><Form.Item name="activeTasks" label="每账号进行中的任务数" extra="包含待审核、排队中的图片、视频、文本和音频任务。" rules={[{ required: true }]}><InputNumber min={0} precision={0} className="!w-full" /></Form.Item></div></div>
            <div className="grid gap-8 border-t border-border py-7 md:grid-cols-[220px_1fr]"><div><h2 className="font-medium">充值订单</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">修改后仅影响新订单。过期订单会先查单确认，再关闭。</p></div><Form.Item name="paymentOrderMinutes" label="订单有效期（分钟）" rules={[{ required: true }]}><InputNumber min={1} precision={0} className="!w-full" /></Form.Item></div>
            <div className="flex justify-end border-t border-border pt-6"><Button type="primary" htmlType="submit" size="large" loading={mutation.isPending}>保存运营设置</Button></div>
        </Form>}
        <MailSettingsPanel />
    </div>;
}
