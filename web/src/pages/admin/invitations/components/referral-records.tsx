import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Table } from "antd";
import dayjs from "dayjs";

import { getAdminReferrals } from "@/services/api/platform-operations";

export default function ReferralRecords() {
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const query = useQuery({ queryKey: ["admin", "referrals", search, page], queryFn: () => getAdminReferrals(search, (page - 1) * 50) });
    return <section className="mt-10 border-t border-border pt-7"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">推荐关系与充值返利</h2><Input.Search className="!w-64" placeholder="搜索邀请人或新用户" allowClear onSearch={(value) => { setSearch(value); setPage(1); }} /></div>
        {query.error ? <Alert type="error" title={query.error.message} /> : null}
        <Table rowKey="id" dataSource={query.data?.referrals || []} loading={query.isPending} pagination={false} columns={[{ title: "邀请人", dataIndex: "inviterName" }, { title: "好友", dataIndex: "username" }, { title: "累计返利", dataIndex: "reward", render: (value: string) => `¥${value}` }, { title: "注册时间", dataIndex: "createdAt", render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm") }]} />
        <div className="mt-4 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button disabled={(query.data?.referrals.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>下一页</Button></div>
    </section>;
}
