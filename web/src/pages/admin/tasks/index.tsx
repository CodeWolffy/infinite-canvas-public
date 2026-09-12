import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import { ListChecks } from "lucide-react";
import dayjs from "dayjs";

import { cancelAdminTask, getAdminTasks } from "@/services/api/tasks";
import { getAuditLogs } from "@/services/api/billing";

const labels: Record<string, string> = { reviewing: "待审核", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", canceled: "已取消", image: "图片", video: "视频", text: "文本", audio: "音频" };

export default function AdminTasksPage() {
    const { message, modal } = App.useApp();
    const [tab, setTab] = useState("tasks");
    const [status, setStatus] = useState("");
    const [capability, setCapability] = useState("");
    const [page, setPage] = useState(1);
    const tasks = useQuery({ queryKey: ["admin-tasks", status, capability, page], queryFn: () => getAdminTasks(status, capability, (page - 1) * 50), enabled: tab === "tasks", refetchInterval: (query) => query.state.data?.tasks.some((task) => ["reviewing", "queued", "running"].includes(task.status)) ? 2500 : false });
    const audit = useQuery({ queryKey: ["audit-logs", page], queryFn: () => getAuditLogs((page - 1) * 50), enabled: tab === "audit" });
    const cancel = useMutation({ mutationFn: cancelAdminTask, onSuccess: () => { void tasks.refetch(); message.success("任务已取消，冻结余额已退回"); }, onError: (error: Error) => message.error(error.message) });

    return <div className="w-full px-5 py-8 lg:px-8"><ListChecks className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">任务与审计</h1><p className="mb-7 mt-2 text-sm text-muted-foreground">查看全部类型的生成任务，以及管理操作记录。</p>
        <Tabs activeKey={tab} onChange={(value) => { setTab(value); setPage(1); }} items={[
            { key: "tasks", label: "生成任务", children: <><Space className="mb-5" wrap><Select className="w-36" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: "", label: "全部状态" }, ...["reviewing", "queued", "running", "succeeded", "failed", "canceled"].map((value) => ({ value, label: labels[value] }))]} /><Select className="w-36" value={capability} onChange={(value) => { setCapability(value); setPage(1); }} options={[{ value: "", label: "全部能力" }, ...["image", "video", "text", "audio"].map((value) => ({ value, label: labels[value] }))]} /><Button onClick={() => void tasks.refetch()}>刷新</Button></Space>{tasks.error ? <Alert type="error" title={tasks.error.message} className="mb-4" /> : null}<Table rowKey="id" dataSource={tasks.data?.tasks || []} loading={tasks.isPending} pagination={false} scroll={{ x: 1000 }} columns={[
                { title: "用户", dataIndex: "username", width: 120 }, { title: "模型", dataIndex: "modelDisplayName", width: 180 }, { title: "类型", dataIndex: "capability", width: 80, render: (value: string) => labels[value] },
                { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "succeeded" ? "success" : value === "failed" ? "error" : "default"}>{labels[value]}</Tag> },
                { title: "尝试次数", width: 95, render: (_, task) => <span className="font-mono">{task.attemptCount ?? 0} / {task.maxAttempts ?? "—"}</span> },
                { title: "提交时间", dataIndex: "queuedAt", width: 155, render: (value: string) => dayjs(value).format("MM-DD HH:mm:ss") }, { title: "说明", dataIndex: "errorMessage", ellipsis: true },
                { title: "操作", key: "actions", width: 90, render: (_, task) => ["reviewing", "queued", "running"].includes(task.status) ? <Button type="text" danger loading={cancel.isPending && cancel.variables === task.id} onClick={() => modal.confirm({ title: "取消此任务？", content: "用户的冻结余额会退回。上游已经接受的生成可能仍会完成。", okText: "取消任务", cancelText: "返回", onOk: () => cancel.mutateAsync(task.id) })}>取消</Button> : null },
            ]} /></> },
            { key: "audit", label: "管理审计", children: <>{audit.error ? <Alert type="error" title={audit.error.message} /> : null}<Table rowKey="id" dataSource={audit.data?.logs || []} loading={audit.isPending} pagination={false} scroll={{ x: 850 }} columns={[
                { title: "操作时间", dataIndex: "createdAt", width: 160, render: (value: string) => dayjs(value).format("MM-DD HH:mm:ss") }, { title: "操作人", dataIndex: "username", width: 130 }, { title: "动作", dataIndex: "action", width: 180 }, { title: "对象", dataIndex: "target", ellipsis: true },
            ]} expandable={{ expandedRowRender: (row) => <Typography.Paragraph className="!mb-0 whitespace-pre-wrap font-mono text-xs">{JSON.stringify(row.detail, null, 2)}</Typography.Paragraph> }} /></> },
        ]} /><div className="mt-5 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><Button disabled={(tab === "tasks" ? tasks.data?.tasks.length || 0 : audit.data?.logs.length || 0) < 50} onClick={() => setPage((value) => value + 1)}>下一页</Button></div>
    </div>;
}
