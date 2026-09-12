import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Descriptions, Drawer, Input, Select, Space, Table, Tag } from "antd";
import dayjs from "dayjs";

import { decideModeration, getModerationReviews, type ModerationReview } from "@/services/api/platform-operations";

const labels: Record<ModerationReview["status"], string> = { pending: "待审核", approved: "已通过", rejected: "已拒绝", canceled: "已取消" };
const capabilities: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

export default function ModerationQueue() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [status, setStatus] = useState("pending");
    const [page, setPage] = useState(1);
    const [selected, setSelected] = useState<ModerationReview | null>(null);
    const [note, setNote] = useState("");
    const query = useQuery({ queryKey: ["admin", "moderation", status, page], queryFn: () => getModerationReviews(status, (page - 1) * 50) });
    const decide = useMutation({ mutationFn: (decision: "approved" | "rejected") => decideModeration(selected!.id, { decision, note }), onSuccess: () => { void client.invalidateQueries({ queryKey: ["admin", "moderation"] }); void client.invalidateQueries({ queryKey: ["admin-tasks"] }); setSelected(null); message.success("审核结果已保存"); }, onError: (error: Error) => message.error(error.message) });
    return <section className="mb-10 border-b border-border pb-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-medium">内容审核</h2><p className="mt-2 text-sm text-muted-foreground">待审核任务保留冻结额，通过后执行，拒绝或取消后退回。</p></div><Space><Select className="w-32" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: "", label: "全部记录" }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} /><Button onClick={() => void query.refetch()}>刷新</Button></Space></div>
        {query.error ? <Alert className="mb-4" type="error" title={query.error.message} /> : null}
        <Table<ModerationReview> rowKey="id" dataSource={query.data?.reviews || []} loading={query.isPending} pagination={false} scroll={{ x: 740 }} columns={[
            { title: "用户", dataIndex: "username", width: 120 }, { title: "模型", dataIndex: "modelDisplayName" },
            { title: "提示词", dataIndex: "prompt", ellipsis: true },
            { title: "状态", dataIndex: "status", width: 110, render: (value: ModerationReview["status"]) => <Tag color={value === "pending" ? "warning" : value === "approved" ? "success" : "default"}>{labels[value]}</Tag> },
            { title: "提交时间", dataIndex: "createdAt", width: 150, render: (value: string) => dayjs(value).format("MM-DD HH:mm:ss") },
            { title: "操作", width: 95, render: (_, review) => <Button type="link" onClick={() => { setSelected(review); setNote(""); }}>{review.status === "pending" ? "审核" : "查看"}</Button> },
        ]} />
        <div className="mt-4 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button disabled={(query.data?.reviews.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>下一页</Button></div>
        <Drawer title="内容审核" open={Boolean(selected)} onClose={() => setSelected(null)} size={680} destroyOnHidden>
            {selected ? <><Descriptions column={2} items={[{ key: "user", label: "用户", children: selected.username }, { key: "model", label: "模型", children: selected.modelDisplayName }, { key: "type", label: "能力", children: capabilities[selected.capability] }, { key: "count", label: "任务数", children: selected.taskCount }, { key: "hold", label: "待审核冻结", children: `¥${selected.frozen}` }, { key: "state", label: "状态", children: labels[selected.status] }]} />
                <h3 className="mb-3 mt-7 text-sm font-medium">命中规则</h3><Space wrap>{selected.matches.map((match) => <Tag key={match.id}>{match.pattern}</Tag>)}</Space>
                <h3 className="mb-3 mt-7 text-sm font-medium">提示词</h3><div className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-4 text-sm leading-7">{selected.prompt}</div>
                {Object.keys(selected.parameters).length ? <><h3 className="mb-3 mt-6 text-sm font-medium">生成参数与系统提示词</h3><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border p-4 text-xs">{JSON.stringify(selected.parameters, null, 2)}</pre></> : null}
                {selected.status === "pending" ? <><label htmlFor="moderation-note" className="mb-3 mt-7 block text-sm font-medium">审核备注</label><Input.TextArea id="moderation-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="拒绝时可说明需要调整的内容" /><Space className="mt-6" wrap><Button type="primary" loading={decide.isPending && decide.variables === "approved"} disabled={decide.isPending} onClick={() => decide.mutate("approved")}>通过并开始生成</Button><Button danger loading={decide.isPending && decide.variables === "rejected"} disabled={decide.isPending} onClick={() => decide.mutate("rejected")}>拒绝并退回冻结</Button></Space></> : <p className="mt-7 text-sm leading-7 text-muted-foreground">审核人：{selected.reviewerName || "—"}<br />{selected.note || "无审核备注"}</p>}
            </> : null}
        </Drawer>
    </section>;
}
