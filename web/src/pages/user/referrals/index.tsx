import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Table } from "antd";
import { Copy, Users } from "lucide-react";
import dayjs from "dayjs";

import { useCopyText } from "@/hooks/use-copy-text";
import { getReferrals, type Referral } from "@/services/api/platform-operations";
import { useUserStore } from "@/stores/use-user-store";

export default function ReferralsPage() {
    const session = useUserStore((state) => state.sessionVersion);
    const [page, setPage] = useState(1);
    const copy = useCopyText();
    const query = useQuery({ queryKey: ["referrals", session, page], queryFn: () => getReferrals((page - 1) * 50) });
    const data = query.data;

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
            <div>
                <div className="flex items-center gap-2 text-stone-500 mb-1">
                    <Users className="size-4 text-indigo-500" />
                    <span className="text-xs font-semibold uppercase tracking-wider">Referrals & Rewards</span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">邀请好友一起创作</h1>
                <p className="mt-1 text-sm text-stone-500">好友通过你的推荐链接注册后，每次充值到账都可按平台当前比例为你带来返利。返利直接计入余额，永久保留。</p>
            </div>
            {query.error ? <Alert className="mt-4" type="error" title={query.error.message} /> : null}
            <div className="my-6 grid gap-6 border-y border-stone-200 py-6 sm:grid-cols-3 dark:border-stone-800">
                <div>
                    <p className="text-xs text-stone-500">已邀请好友</p>
                    <p className="mt-2 font-mono text-3xl font-semibold text-stone-950 dark:text-stone-100">{data?.summary.invited ?? "—"}</p>
                </div>
                <div>
                    <p className="text-xs text-stone-500">累计返利</p>
                    <p className="mt-2 font-mono text-3xl font-semibold text-stone-950 dark:text-stone-100">¥{data?.summary.earned ?? "—"}</p>
                </div>
                <div>
                    <p className="text-xs text-stone-500">当前充值返利比例</p>
                    <p className="mt-2 font-mono text-3xl font-semibold text-stone-950 dark:text-stone-100">{data ? (data.enabled ? `${data.percent}%` : "暂未开放") : "—"}</p>
                </div>
            </div>
            <div>
                <label htmlFor="referral-url" className="mb-2 block text-sm font-medium text-stone-950 dark:text-stone-100">你的推荐链接</label>
                <div className="flex gap-2">
                    <Input id="referral-url" size="large" readOnly value={data?.url || ""} />
                    <Button size="large" icon={<Copy className="size-4" />} disabled={!data} onClick={() => data && copy(data.url, "推荐链接已复制")}>复制</Button>
                </div>
                <p className="mt-2 text-xs leading-5 text-stone-500">好友仍需有效的注册邀请码。返利按每笔实际支付的充值金额计算，注册、兑换码和签到不参与返利；关闭期间的充值不补发。</p>
            </div>
            <Table<Referral>
                rowKey="id"
                dataSource={data?.referrals || []}
                loading={query.isPending}
                pagination={{ current: page, pageSize: 50, total: data?.summary.invited || 0, showSizeChanger: false, onChange: setPage }}
                columns={[
                    { title: "好友", dataIndex: "displayName" },
                    { title: "累计返利", dataIndex: "reward", render: (value: string) => <span className="font-mono">¥{value}</span> },
                    { title: "注册时间", dataIndex: "createdAt", render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm") },
                ]}
            />
        </div>
    );
}
