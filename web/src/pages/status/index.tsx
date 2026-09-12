import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Segmented, Table, Tag } from "antd";
import { Activity, ArrowUpRight, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import dayjs from "dayjs";

import { getPublicStatus, type ModelAvailability } from "@/services/api/platform-operations";

const states = { available: { text: "可用", color: "success" }, degraded: { text: "部分可用", color: "warning" }, unavailable: { text: "不可用", color: "error" }, unknown: { text: "待检测", color: "default" } };
const capabilities: Record<string, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };

export default function StatusPage() {
    const [capability, setCapability] = useState("all");
    const query = useQuery({ queryKey: ["public-model-status"], queryFn: getPublicStatus, retry: false });
    const models = query.data?.models || [];
    return <main className="min-h-dvh overflow-y-auto bg-background px-5 py-8 text-foreground sm:px-8">
        <div className="mx-auto max-w-5xl">
            <header className="flex items-center justify-between border-b border-border pb-6"><Link to="/" className="flex items-center gap-2 text-sm font-medium"><span className="size-5 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />Infinite Canvas</Link><Link to="/text" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">开始创作<ArrowUpRight className="size-4" /></Link></header>
            <section className="py-12 sm:py-16"><Activity className="mb-5 size-6 text-muted-foreground" /><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">模型运行状态</h1><p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">这里展示各模型最近一次生成检测结果。未检测或自动检测未及时更新的模型显示为「待检测」，实际请求仍可能受上游波动影响。</p></section>
            <div className="mb-9 grid grid-cols-2 gap-6 border-y border-border py-7 sm:grid-cols-4">{Object.entries(states).map(([status, info]) => <div key={status}><p className="text-xs text-muted-foreground">{info.text}</p><p className="mt-2 font-mono text-3xl">{query.data ? models.filter((model) => model.status === status).length : "—"}</p></div>)}</div>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><Segmented value={capability} onChange={(value) => setCapability(String(value))} options={[{ value: "all", label: "全部模型" }, ...Object.entries(capabilities).map(([value, label]) => ({ value, label }))]} /><Button type="text" icon={<RefreshCw className="size-4" />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新状态</Button></div>
            {query.error ? <Alert className="mb-5" type="error" showIcon title="暂时无法读取模型状态" description={query.error.message} /> : null}
            <Table<ModelAvailability> rowKey="id" pagination={false} loading={query.isPending} dataSource={models.filter((model) => capability === "all" || model.capability === capability)} scroll={{ x: 560 }} columns={[
                { title: "模型", dataIndex: "displayName", render: (value: string) => <span className="font-medium">{value}</span> },
                { title: "能力", dataIndex: "capability", width: 100, render: (value: string) => capabilities[value] || value },
                { title: "状态", dataIndex: "status", width: 140, render: (value: ModelAvailability["status"]) => <Tag color={states[value].color}>{states[value].text}</Tag> },
                { title: "最近检测", dataIndex: "checkedAt", width: 170, render: (value: string | null) => <span className="text-xs text-muted-foreground">{value ? dayjs(value).format("MM-DD HH:mm:ss") : "暂无检测记录"}</span> },
            ]} />
        </div>
    </main>;
}
